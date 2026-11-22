import { Router } from 'express';
import { z } from 'zod';
import { assert, HttpError } from '../lib/errors.js';
import { canEdit, audit } from '../services/auth.js';
import { enforceCount, entitlements } from '../services/limits.js';
import { resolveTarget } from '../services/uptime.js';
import { registrableDomain } from '../services/rdap.js';
import { trySyncMonitor, tryRemoveMonitor } from '../queues/checks.js';
import {
  runCheck,
  recordCheckResult,
  ensureResource,
  daysLeft,
  warningBand,
  tcpTarget,
  hostOf,
} from '../services/checks.js';

const MASK = '••••';
const FORBIDDEN_HEADERS = ['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade'];
const RANGES = {
  '1h': { ms: 3600000, bucket: 60 },
  '24h': { ms: 86400000, bucket: 300 },
  '7d': { ms: 7 * 86400000, bucket: 1800 },
  '30d': { ms: 30 * 86400000, bucket: 7200 },
};

const headers = z
  .record(
    z.string().regex(/^[A-Za-z0-9-]{1,60}$/, 'Header names use letters, numbers and dashes.'),
    z.string().max(500),
  )
  .refine((h) => Object.keys(h).length <= 10, 'Use at most 10 headers.')
  .refine((h) => !Object.keys(h).some((k) => FORBIDDEN_HEADERS.includes(k.toLowerCase())), 'That header cannot be set.');
const fields = {
  name: z.string().trim().min(2).max(100),
  url: z.string().trim().url().max(2048),
  host: z.string().trim().min(1).max(253),
  port: z.coerce.number().int().min(1).max(65535),
  intervalSeconds: z.coerce.number().int().min(30).max(86400),
  timeoutSeconds: z.coerce.number().int().min(2).max(30),
  failuresBeforeDown: z.coerce.number().int().min(1).max(5),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']),
  headers,
  body: z.string().max(4096).nullable(),
  expectedStatus: z.coerce.number().int().min(100).max(599).nullable(),
  keyword: z.string().trim().min(1).max(200).nullable(),
  keywordMode: z.enum(['present', 'absent']),
  jsonContains: z.string().max(500).nullable(),
};
const createInput = z.object({ ...fields, type: z.enum(['http', 'keyword', 'api', 'tcp']) })
  .partial()
  .required({ name: true, type: true });
const updateInput = z.object(fields).partial();

/**
 * A body that starts like JSON (or is sent as application/json) must parse. JSON has no comments, so
 * a body with "// ..." lines is refused here instead of making the target answer 500 on every check.
 */
export function assertJsonBody(body, headers = {}) {
  if (!body) return;
  const type = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] || '';
  if (!/json/i.test(type) && !/^\s*[{[]/.test(body)) return;
  try {
    JSON.parse(body);
  } catch (error) {
    throw new HttpError(400, `The request body is not valid JSON (${error.message}). JSON cannot contain // comments or trailing commas.`, {
      code: 'invalid_json_body',
      hint: 'Remove comment lines and check commas and quotes, then save again.',
    });
  }
}

export function websiteRoutes(store, limits) {
  const router = Router();
  const org = (req) => req.context.orgId;

  async function defaultProjectId(orgId) {
    const project = (await store.list('project', { orgId })).filter((p) => !p.deletedAt)
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    assert(project, 400, 'This organization has no project yet.');
    return project.id;
  }
  async function requireMonitor(req) {
    const monitor = await store.find('uptimeMonitor', { id: req.params.id, orgId: org(req) });
    assert(monitor, 404, 'Website not found.');
    return monitor;
  }

  function present(monitor, uptime24h = null, now = Date.now()) {
    const sslDays = daysLeft(monitor.certificateExpiresAt, now);
    const domainDays = daysLeft(monitor.domainExpiresAt, now);
    const tcp = monitor.type === 'tcp';
    const url = tcp ? null : new URL(monitor.target);
    return {
      id: monitor.id,
      name: monitor.name,
      type: monitor.type,
      target: monitor.target,
      host: hostOf(monitor.target),
      port: tcp ? Number(new URL(monitor.target).port) : null,
      method: monitor.method,
      headers: Object.fromEntries(Object.keys(monitor.headers || {}).map((k) => [k, MASK])),
      hasBody: !!monitor.body,
      expectedStatus: monitor.expectedStatus,
      keyword: monitor.keyword,
      keywordMode: monitor.keywordMode,
      jsonContains: monitor.jsonContains,
      intervalSeconds: monitor.intervalSeconds,
      timeoutSeconds: monitor.timeoutSeconds,
      failuresBeforeDown: monitor.failureThreshold,
      enabled: monitor.enabled,
      paused: !monitor.enabled,
      status: !monitor.enabled ? 'paused' : monitor.status === 'healthy' ? 'up' : monitor.status === 'unhealthy' ? 'down' : 'pending',
      retrying: monitor.enabled && monitor.consecutiveFailures > 0 && monitor.status !== 'unhealthy',
      downSince: monitor.downSince,
      latencyMs: monitor.latencyMs,
      lastCheckedAt: monitor.lastCheckedAt,
      nextCheckAt: monitor.nextCheckAt,
      lastError: monitor.lastError,
      uptime24h,
      ssl:
        monitor.certificateExpiresAt && url?.protocol === 'https:'
          ? { expiresAt: monitor.certificateExpiresAt, daysLeft: sslDays, warning: warningBand(sslDays) }
          : null,
      domain: monitor.domain
        ? {
            name: monitor.domain,
            expiresAt: monitor.domainExpiresAt,
            daysLeft: domainDays,
            warning: warningBand(domainDays),
            status: monitor.domainStatus,
          }
        : null,
      createdAt: monitor.createdAt,
    };
  }

  /** Percent of checks that passed since `since`, per monitor. */
  async function uptimeFor(orgId, monitorIds, since) {
    const groups = await store.client.uptimeCheck.groupBy({
      by: ['monitorId', 'ok'],
      where: { orgId, monitorId: { in: monitorIds }, createdAt: { gte: since } },
      _count: true,
    });
    const totals = new Map();
    for (const g of groups) {
      const t = totals.get(g.monitorId) ?? { ok: 0, all: 0 };
      t.all += g._count;
      if (g.ok) t.ok += g._count;
      totals.set(g.monitorId, t);
    }
    return (id) => {
      const t = totals.get(id);
      return t ? Math.round((t.ok / t.all) * 10000) / 100 : null;
    };
  }

  /** Turn validated input into stored columns and verify the destination is a public address. */
  async function toColumns(input, current = {}) {
    const type = current.type ?? input.type;
    const cols = {};
    if (input.name) cols.name = input.name;
    if (input.intervalSeconds) cols.intervalSeconds = input.intervalSeconds;
    if (input.timeoutSeconds) cols.timeoutSeconds = input.timeoutSeconds;
    if (input.failuresBeforeDown) cols.failureThreshold = input.failuresBeforeDown;
    if (type === 'tcp') {
      const host = input.host ?? (current.target ? hostOf(current.target) : undefined);
      const port = input.port ?? (current.target ? Number(new URL(current.target).port) : undefined);
      assert(host && port, 400, 'Enter the host and port to check.');
      if (input.host || input.port || !current.target) cols.target = tcpTarget(host, port);
    } else if (input.url || !current.target) {
      assert(input.url, 400, 'Enter the web address to check.');
      assert(/^https?:\/\//i.test(input.url), 400, 'Use an http:// or https:// address.');
      cols.target = new URL(input.url).toString();
    }
    if (cols.target) {
      await resolveTarget(cols.target);
      cols.domain = type === 'tcp' ? null : registrableDomain(hostOf(cols.target));
      if (cols.domain !== current.domain) Object.assign(cols, { domainExpiresAt: null, domainCheckedAt: null, domainStatus: null });
      cols.certificateExpiresAt = null;
    }
    if (type === 'keyword') {
      const keyword = input.keyword ?? current.keyword;
      assert(keyword, 400, 'Enter the word or phrase to look for.');
      cols.keyword = keyword;
      if (input.keywordMode) cols.keywordMode = input.keywordMode;
    }
    if (type === 'api') {
      if (input.method) cols.method = input.method;
      if (input.headers) {
        // A masked value means "keep what is saved".
        cols.headers = Object.fromEntries(
          Object.entries(input.headers).map(([k, v]) => [k, v === MASK ? (current.headers?.[k] ?? '') : v]),
        );
      }
      if (input.body !== undefined) {
        cols.body = input.body;
        const sent = { ...(current.headers || {}), ...(cols.headers || {}) };
        assertJsonBody(input.body, sent);
      }
      if (input.expectedStatus !== undefined) cols.expectedStatus = input.expectedStatus;
      if (input.jsonContains !== undefined) cols.jsonContains = input.jsonContains || null;
    }
    return cols;
  }
  async function assertPlan(orgId, intervalSeconds) {
    const { plan } = await entitlements(store, orgId);
    assert(
      intervalSeconds >= plan.minCheckIntervalSeconds,
      402,
      `Your ${plan.name} plan checks at most every ${plan.minCheckIntervalSeconds} seconds.`,
    );
  }

  router.get('/websites', async (req, res) => {
    const monitors = (await store.list('uptimeMonitor', { orgId: org(req) })).sort((a, b) => a.createdAt - b.createdAt);
    const uptime = await uptimeFor(org(req), monitors.map((m) => m.id), new Date(Date.now() - 86400000));
    const { plan } = await entitlements(store, org(req));
    res.json({
      items: monitors.map((m) => present(m, uptime(m.id))),
      limits: { used: monitors.length, max: plan.monitors, minIntervalSeconds: plan.minCheckIntervalSeconds },
    });
  });

  router.post('/websites', canEdit, async (req, res) => {
    const input = createInput.parse(req.body);
    const orgId = org(req);
    const intervalSeconds = input.intervalSeconds ?? 300;
    await assertPlan(orgId, intervalSeconds);
    await enforceCount(store, orgId, 'monitors', (await store.list('uptimeMonitor', { orgId })).length);
    const cols = await toColumns({ ...input, intervalSeconds });
    const monitor = await store.create('uptimeMonitor', {
      orgId,
      projectId: await defaultProjectId(orgId),
      type: input.type,
      failureThreshold: 2,
      status: 'pending',
      consecutiveFailures: 0,
      enabled: true,
      nextCheckAt: new Date(),
      ...cols,
    });
    await ensureResource(store, monitor, null);
    await trySyncMonitor(monitor, { immediate: true });
    await audit(store, req.context, 'website.created', monitor.name);
    res.status(201).json(present(monitor));
  });

  router.get('/websites/:id', async (req, res) => {
    const monitor = await requireMonitor(req);
    const out = {};
    for (const [label, ms] of [['24h', 86400000], ['7d', 7 * 86400000], ['30d', 30 * 86400000]])
      out[label] = (await uptimeFor(org(req), [monitor.id], new Date(Date.now() - ms)))(monitor.id);
    res.json({ ...present(monitor, out['24h']), uptime: out });
  });

  router.patch('/websites/:id', canEdit, async (req, res) => {
    const monitor = await requireMonitor(req);
    const input = updateInput.parse(req.body);
    if (input.intervalSeconds) await assertPlan(org(req), input.intervalSeconds);
    const cols = await toColumns(input, monitor);
    const row = await store.update('uptimeMonitor', monitor.id, { ...cols, nextCheckAt: new Date() });
    await trySyncMonitor(row, { immediate: true });
    if (cols.name) {
      const resource = await store.find('monitoredResource', { orgId: org(req), externalId: monitor.id });
      if (resource) await store.update('monitoredResource', resource.id, { name: cols.name });
    }
    res.json(present(row));
  });

  router.delete('/websites/:id', canEdit, async (req, res) => {
    const monitor = await requireMonitor(req);
    // Keep the resource row (soft delete) so incident history still has a name to show.
    await store.updateMany('monitoredResource', { orgId: org(req), externalId: monitor.id }, { deletedAt: new Date() });
    await store.remove('uptimeMonitor', monitor.id);
    await tryRemoveMonitor(monitor.id);
    await audit(store, req.context, 'website.deleted', monitor.name);
    res.status(204).end();
  });

  router.post('/websites/:id/pause', canEdit, async (req, res) => {
    const monitor = await requireMonitor(req);
    const row = await store.update('uptimeMonitor', monitor.id, { enabled: false });
    await trySyncMonitor(row);
    res.json(present(row));
  });
  router.post('/websites/:id/resume', canEdit, async (req, res) => {
    const monitor = await requireMonitor(req);
    const row = await store.update('uptimeMonitor', monitor.id, { enabled: true, nextCheckAt: new Date() });
    await trySyncMonitor(row, { immediate: true });
    res.json(present(row));
  });

  router.post('/websites/:id/check', canEdit, async (req, res) => {
    const monitor = await requireMonitor(req);
    await limits.use(`website-check:${org(req)}`, 1, 10);
    const result = await runCheck(monitor);
    let resource = await store.find('monitoredResource', { orgId: org(req), externalId: monitor.id });
    resource = await ensureResource(store, monitor, resource);
    await recordCheckResult(store, monitor, result, resource);
    res.json({ ok: result.ok, statusCode: result.statusCode, latencyMs: result.latencyMs, error: result.error, detail: result.detail ?? null });
  });

  router.get('/websites/:id/checks', async (req, res) => {
    const monitor = await requireMonitor(req);
    const { range } = z.object({ range: z.enum(['1h', '24h', '7d', '30d']).default('24h') }).parse(req.query);
    const { plan } = await entitlements(store, org(req));
    const { ms, bucket } = RANGES[range];
    const since = new Date(Math.max(Date.now() - ms, Date.now() - plan.retentionDays * 86400000));
    const rows = await store.client.$queryRaw`
      SELECT date_bin(make_interval(secs => ${bucket}::double precision), "createdAt", TIMESTAMP '2000-01-01') AS bucket,
             AVG("latencyMs") FILTER (WHERE ok) AS avg, MAX("latencyMs") AS max,
             COUNT(*) FILTER (WHERE ok) AS ok, COUNT(*) FILTER (WHERE NOT ok) AS failed
      FROM "UptimeCheck"
      WHERE "monitorId" = ${monitor.id} AND "createdAt" >= ${since}
      GROUP BY 1 ORDER BY 1`;
    const points = rows.map((r) => ({
      time: new Date(r.bucket).toISOString(),
      avgLatencyMs: r.avg == null ? null : Math.round(Number(r.avg)),
      maxLatencyMs: r.max == null ? null : Math.round(Number(r.max)),
      ok: Number(r.ok),
      failed: Number(r.failed),
    }));
    const ok = points.reduce((s, p) => s + p.ok, 0);
    const total = ok + points.reduce((s, p) => s + p.failed, 0);
    const weighted = points.filter((p) => p.avgLatencyMs != null);
    const avg = weighted.length
      ? Math.round(weighted.reduce((s, p) => s + p.avgLatencyMs * p.ok, 0) / Math.max(1, weighted.reduce((s, p) => s + p.ok, 0)))
      : null;
    const recent = await store.client.uptimeCheck.findMany({
      where: { monitorId: monitor.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    res.json({
      range,
      bucketSeconds: bucket,
      uptimePercent: total ? Math.round((ok / total) * 10000) / 100 : null,
      avgLatencyMs: avg,
      checks: total,
      points,
      recent: recent.map((c) => ({
        time: c.createdAt,
        ok: c.ok,
        statusCode: c.statusCode,
        latencyMs: c.latencyMs,
        error: c.error,
        detail: c.detail,
      })),
    });
  });
  return router;
}
