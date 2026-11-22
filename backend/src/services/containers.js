import { assert, HttpError } from '../lib/errors.js';
import { entitlements } from './limits.js';
import { retentionCutoff } from './metrics.js';
import { liveServers, requireServer, saveAgentSettings } from './servers.js';
import { agentSettingsSchema, configForAgent } from './agent-config.js';
import { select, tables } from '../lib/clickhouse.js';
import { retentionDays } from './otel-usage.js';
import { SEVERITY_LEVELS, levelOfSeverityNumber } from './otel-transform.js';
import { registerMetricSource } from './alert-metrics.js';

export const MISSING_AFTER_MS = 5 * 60000; // a container absent this long (while the server reports) is "removed"
export const REMOVED_KEEP_MS = 7 * 86400000;
export const STOPPED_INGESTS = 2; // consecutive not-running snapshots before "Container stopped" can fire
const FRESH_MS = 150000;
const EVENTS_SHOWN = 50;
const EVENT_KEEP_MS = 30 * 86400000;

const STATE_MAP = {
  running: 'running',
  restarting: 'restarting',
  paused: 'paused',
  exited: 'stopped',
  created: 'stopped',
  dead: 'stopped',
  removing: 'stopped',
};
export const normalizeContainerState = (raw) => STATE_MAP[raw] ?? 'stopped';
export const CONTAINER_STATES = ['running', 'restarting', 'paused', 'stopped', 'removed'];

/** Write one state-change event (shared with services). */
export const recordStateEvent = (store, event) => store.client.stateEvent.create({ data: event });

export async function trimStateEvents(store, agentId, now = Date.now()) {
  await store.client.stateEvent.deleteMany({
    where: { agentId, createdAt: { lt: new Date(now - EVENT_KEEP_MS) } },
  });
}

/**
 * Apply one container snapshot from an agent. `reportedAt` is the snapshot time; a snapshot that is not
 * newer than what a row already holds is ignored, so a retried request cannot count twice.
 */
export async function recordContainers(
  store,
  agent,
  containers,
  { reportedAt, now = Date.now(), insertMetrics = true },
) {
  const db = store.client;
  const at = new Date(now);
  const rows = await db.containerItem.findMany({ where: { agentId: agent.id } });
  const byName = new Map(rows.map((r) => [r.name, r]));
  const seen = new Set();
  const metrics = [];
  const ids = {};
  const base = { orgId: agent.orgId, agentId: agent.id };

  for (const c of new Map(containers.map((x) => [x.name, x])).values()) {
    seen.add(c.name);
    const state = normalizeContainerState(c.state);
    const existing = byName.get(c.name);
    const fields = {
      dockerId: c.id,
      image: c.image,
      rawState: c.state,
      status: c.status ?? '',
      restartCount: c.restartCount,
      cpuPercent: c.cpuPercent ?? null,
      memoryBytes: c.memoryBytes ?? null,
      memoryLimitBytes: c.memoryLimitBytes || null,
      startedAt: c.startedAt ? new Date(c.startedAt) : null,
      lastSeen: at,
      reportedAt,
    };
    let item;
    if (!existing) {
      item = await db.containerItem.create({
        data: {
          ...base,
          name: c.name,
          state,
          ...fields,
          wasRunning: state === 'running',
          stoppedStreak: state === 'stopped' ? 1 : 0,
          firstSeen: at,
          stateChangedAt: at,
        },
      });
      await recordStateEvent(store, {
        ...base,
        subjectType: 'container',
        subjectId: item.id,
        subjectName: c.name,
        type: 'appeared',
        message: `Container ${c.name} appeared (${state}).`,
      });
    } else {
      ids[c.name] = existing.id;
      if (existing.reportedAt >= reportedAt) continue;
      const changed = existing.state !== state;
      const event = (type, message) =>
        recordStateEvent(store, { ...base, subjectType: 'container', subjectId: existing.id, subjectName: c.name, type, message });
      if (changed && state === 'running')
        await event('started', `Container ${c.name} is running${existing.state === 'removed' ? ' again' : ''}.`);
      if (changed && state === 'stopped')
        await event(c.oomKilled ? 'oom' : 'stopped', c.oomKilled ? `Container ${c.name} was killed for running out of memory.` : `Container ${c.name} stopped.`);
      else if (c.oomKilled && !changed && c.restartCount > existing.restartCount)
        await event('oom', `Container ${c.name} was killed for running out of memory.`);
      if (c.restartCount > existing.restartCount)
        await event('restarted', `Container ${c.name} restarted (${c.restartCount - existing.restartCount} time${c.restartCount - existing.restartCount === 1 ? '' : 's'}).`);
      item = await db.containerItem.update({
        where: { id: existing.id },
        data: {
          ...fields,
          state,
          wasRunning: existing.wasRunning || state === 'running',
          stoppedStreak: state === 'stopped' ? (existing.state === 'removed' ? 1 : existing.stoppedStreak + 1) : 0,
          ...(changed ? { stateChangedAt: at } : {}),
        },
      });
    }
    ids[c.name] = item.id;
    if (state !== 'stopped' || c.cpuPercent != null || c.memoryBytes != null)
      metrics.push({
        time: reportedAt,
        containerId: item.id,
        ...base,
        cpuPercent: c.cpuPercent ?? null,
        memoryBytes: c.memoryBytes ?? null,
        memoryLimitBytes: c.memoryLimitBytes || null,
        restartCount: c.restartCount,
      });
  }

  // Containers that stopped appearing in the snapshot: removed after a few minutes of absence.
  for (const row of rows) {
    if (seen.has(row.name) || row.state === 'removed') continue;
    if (now - row.lastSeen.getTime() < MISSING_AFTER_MS) continue;
    await db.containerItem.update({
      where: { id: row.id },
      data: { state: 'removed', stoppedStreak: 0, stateChangedAt: at },
    });
    await recordStateEvent(store, {
      ...base,
      subjectType: 'container',
      subjectId: row.id,
      subjectName: row.name,
      type: 'removed',
      message: `Container ${row.name} is no longer on this server.`,
    });
  }
  await db.containerItem.deleteMany({
    where: { agentId: agent.id, state: 'removed', lastSeen: { lt: new Date(now - REMOVED_KEEP_MS) } },
  });
  if (insertMetrics && metrics.length)
    await db.containerMetric.createMany({ data: metrics, skipDuplicates: true });
  // With insertMetrics: false the caller batches the rows; `ids` maps container name to row id.
  // `pending`: rows the snapshot no longer mentions (waiting to be marked removed or deleted), so the
  // caller must keep applying snapshots instead of skipping unchanged ones.
  return { metrics, ids, pending: rows.some((r) => !seen.has(r.name)) };
}

/** Plans with shorter history than the raw retention policy (8 days) get older container samples removed. */
export async function trimContainerMetricsByPlan(store) {
  return store.client.$executeRaw`
    DELETE FROM container_metrics m
    USING "Subscription" s JOIN "SubscriptionPlan" p ON p."id" = s."planId"
    WHERE s."orgId" = m.org_id
      AND p."retentionDays" < 8
      AND m."time" < now() - make_interval(days => p."retentionDays")`;
}

// ---------------------------------------------------------------------------------------------- reads

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function containerToApi(c, server) {
  return {
    id: c.id,
    serverId: c.agentId,
    serverName: server?.name ?? null,
    serverKind: server?.kind ?? 'server',
    name: c.name,
    image: c.image,
    state: c.state,
    statusText: c.status,
    restarts: c.restartCount,
    cpuPercent: c.state === 'running' ? num(c.cpuPercent) : null,
    memoryBytes: c.state === 'running' ? num(c.memoryBytes) : null,
    memoryLimitBytes: num(c.memoryLimitBytes),
    startedAt: c.startedAt,
    firstSeen: c.firstSeen,
    lastSeen: c.lastSeen,
    stateChangedAt: c.stateChangedAt,
  };
}
export const eventToApi = (e) => ({ id: e.id, type: e.type, message: e.message, at: e.createdAt });

/** Map of agent id to { name } for the org's live (not removed) servers. */
export async function serverNames(store, orgId) {
  const live = await liveServers(store, orgId);
  return new Map(live.map(({ agent, resource }) => [agent.id, { name: resource.name, hostname: agent.name, kind: agent.kind || 'server', lastSeen: agent.lastSeen }]));
}

export async function listContainers(store, orgId, { serverId, state, search } = {}) {
  const servers = await serverNames(store, orgId);
  const where = { orgId, agentId: serverId ? serverId : { in: [...servers.keys()] } };
  if (state && state !== 'all') where.state = state;
  else if (!state) where.state = { not: 'removed' };
  if (search) where.name = { contains: search, mode: 'insensitive' };
  const rows = await store.client.containerItem.findMany({ where, orderBy: [{ name: 'asc' }] });
  const live = rows.filter((r) => servers.has(r.agentId));
  const all = await store.client.containerItem.groupBy({
    by: ['state'],
    where: { orgId, agentId: { in: [...servers.keys()] } },
    _count: true,
  });
  const summary = Object.fromEntries(CONTAINER_STATES.map((s) => [s, 0]));
  for (const g of all) summary[g.state] = g._count;
  summary.total = CONTAINER_STATES.filter((s) => s !== 'removed').reduce((a, s) => a + summary[s], 0);
  return {
    items: live.map((r) => containerToApi(r, servers.get(r.agentId))),
    summary,
  };
}

export async function requireContainer(store, orgId, id) {
  const row = /^[0-9a-f-]{36}$/.test(id) ? await store.client.containerItem.findFirst({ where: { id, orgId } }) : null;
  const servers = await serverNames(store, orgId);
  assert(row && servers.has(row.agentId), 404, 'Container not found.');
  return { row, server: servers.get(row.agentId) };
}

export async function containerDetail(store, row, server) {
  const events = await store.client.stateEvent.findMany({
    where: { subjectType: 'container', subjectId: row.id },
    orderBy: { createdAt: 'desc' },
    take: EVENTS_SHOWN,
  });
  const agent = await store.find('agent', { id: row.agentId });
  const setup = agent && (await configForAgent(store, agent));
  return {
    ...containerToApi(row, server),
    events: events.map(eventToApi),
    logsEnabled: collectsLogs(setup?.settings, row.name),
  };
}

export const CONTAINER_RANGES = {
  '1h': { ms: 3600000, bucketSeconds: null },
  '24h': { ms: 86400000, bucketSeconds: 300 },
  '7d': { ms: 7 * 86400000, bucketSeconds: 3600 },
};

/** Chart data for one container: raw samples for 1h, time-bucketed averages beyond. Clamped to the plan's history. */
export async function containerMetrics(store, row, rangeKey) {
  const range = CONTAINER_RANGES[rangeKey];
  const { plan } = await entitlements(store, row.orgId);
  const to = new Date();
  const wanted = new Date(to.getTime() - range.ms);
  const floor = retentionCutoff(plan, to.getTime());
  const clamped = floor > wanted;
  const from = clamped ? floor : wanted;
  const db = store.client;
  const rows = range.bucketSeconds
    ? await db.$queryRaw`
        SELECT time_bucket(make_interval(secs => ${range.bucketSeconds}), "time") AS t,
          avg(cpu_percent) AS cpu, max(cpu_percent) AS "cpuMax",
          avg(memory_bytes) AS mem, max(memory_bytes) AS "memMax",
          max(memory_limit_bytes) AS "memLimit", max(restart_count) AS restarts
        FROM container_metrics
        WHERE container_id = ${row.id} AND "time" >= ${from} AND "time" <= ${to}
        GROUP BY 1 ORDER BY 1`
    : await db.$queryRaw`
        SELECT "time" AS t, cpu_percent AS cpu, cpu_percent AS "cpuMax", memory_bytes AS mem,
          memory_bytes AS "memMax", memory_limit_bytes AS "memLimit", restart_count AS restarts
        FROM container_metrics
        WHERE container_id = ${row.id} AND "time" >= ${from} AND "time" <= ${to}
        ORDER BY "time"`;
  return {
    range: rangeKey,
    bucketSeconds: range.bucketSeconds,
    clamped,
    from,
    to,
    points: rows.map((r) => ({
      t: r.t,
      cpu: num(r.cpu),
      cpuMax: num(r.cpuMax),
      memoryBytes: num(r.mem),
      memoryMaxBytes: num(r.memMax),
      memoryLimitBytes: num(r.memLimit),
      restartCount: num(r.restarts === null ? null : Number(r.restarts)),
    })),
  };
}

// ---------------------------------------------------------------------------------------------- logs

/** Severity words the agent (or an app) may write, by level, plus the matching OTLP severity numbers. */
const LOG_LEVELS = {
  error: { words: ['error', 'err', 'fatal', 'critical', 'crit', 'panic', 'emerg', 'alert'], from: 17, to: 24 },
  warn: { words: ['warn', 'warning'], from: 13, to: 16 },
  info: { words: ['info', 'information', 'notice'], from: 9, to: 12 },
  debug: { words: ['debug', 'trace'], from: 1, to: 8 },
};
export const LOG_LEVEL_NAMES = Object.keys(LOG_LEVELS);
function levelOf(text, number) {
  const word = String(text || '').toLowerCase();
  for (const [name, level] of Object.entries(LOG_LEVELS)) if (level.words.includes(word)) return name;
  const byNumber = SEVERITY_LEVELS[levelOfSeverityNumber(Number(number)) - 1];
  return { trace: 'debug', fatal: 'error' }[byNumber] ?? byNumber ?? '';
}

const ISO = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
/** ISO time with up to 9 fraction digits -> nanoseconds since the epoch (BigInt). */
export function isoToNanos(value) {
  const match = ISO.exec(value);
  const ms = match ? Date.parse(`${match[1]}${match[3]}`) : NaN;
  assert(Number.isFinite(ms), 400, 'Times must be ISO 8601, for example 2026-11-22T10:00:00Z.');
  return BigInt(ms) * 1000000n + BigInt((match[2] ?? '').padEnd(9, '0'));
}
/** Nanoseconds (string or BigInt) -> ISO time with all 9 fraction digits (round-trips through `since`). */
export function nanosToIso(ns) {
  const n = BigInt(ns);
  const fraction = String(n % 1000000000n).padStart(9, '0');
  return `${new Date(Number(n / 1000000000n) * 1000).toISOString().slice(0, 19)}.${fraction}Z`;
}

/** ClickHouse trouble becomes the usual structured 503, not a 500. */
async function guarded(work) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpError || error.name === 'ZodError') throw error;
    console.error('container logs query failed:', error.message);
    throw new HttpError(503, 'Telemetry storage is unavailable. Try again shortly.', {
      code: 'telemetry_unavailable',
      service: 'clickhouse',
    });
  }
}

/**
 * Log lines of one container (docs/api/advanced-telemetry.md section 5), oldest first.
 * - Without `since`: the newest `limit` lines (up to `until`, within the plan's log retention).
 * - With `since` (exclusive): the next `limit` lines after it, for live tail. Pass `nextSince` back as `since`.
 * Lines are matched by organization, the reporting agent, and the container's name or Docker id.
 */
export async function containerLogs(store, row, { since, until, q, level, stream, limit = 200 } = {}) {
  const { plan } = await entitlements(store, row.orgId);
  const now = Date.now();
  const floor = BigInt(now - retentionDays(plan.id) * 86400000) * 1000000n;
  const sinceNs = since ? isoToNanos(since) : null;
  const untilNs = until ? isoToNanos(until) : null;
  const params = {
    org: row.orgId,
    agent: row.agentId,
    name: row.name,
    short: String(row.dockerId || '').slice(0, 12) || '-',
    fromNs: String(sinceNs !== null && sinceNs > floor ? sinceNs : floor),
    limit,
  };
  const filters = [
    'OrgId = {org:String}',
    "ResourceAttributes['yk.agent'] = {agent:String}",
    "(ServiceName = {name:String} OR ResourceAttributes['container.name'] = {name:String} OR substring(ResourceAttributes['container.id'], 1, 12) = {short:String})",
    sinceNs !== null && sinceNs > floor
      ? 'Timestamp > fromUnixTimestamp64Nano({fromNs:Int64})'
      : 'Timestamp >= fromUnixTimestamp64Nano({fromNs:Int64})',
  ];
  if (untilNs !== null) {
    filters.push('Timestamp <= fromUnixTimestamp64Nano({untilNs:Int64})');
    params.untilNs = String(untilNs);
  }
  if (level) {
    const l = LOG_LEVELS[level];
    filters.push('(lowerUTF8(SeverityText) IN {levelWords:Array(String)} OR SeverityNumber BETWEEN {levelFrom:UInt8} AND {levelTo:UInt8})');
    Object.assign(params, { levelWords: l.words, levelFrom: l.from, levelTo: l.to });
  }
  if (stream) {
    filters.push("LogAttributes['log.iostream'] = {stream:String}");
    params.stream = stream;
  }
  (q ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .forEach((term, i) => {
      filters.push(`positionCaseInsensitive(Body, {term${i}:String}) > 0`);
      params[`term${i}`] = term;
    });
  const order = sinceNs !== null ? 'ASC' : 'DESC';
  const rows = await guarded(() =>
    select(
      `SELECT toString(toUnixTimestamp64Nano(Timestamp)) AS ns, SeverityText AS severityText, SeverityNumber AS severityNumber,
              LogAttributes['log.iostream'] AS stream, Body AS body
         FROM ${tables.logs}
        WHERE ${filters.join(' AND ')}
        ORDER BY Timestamp ${order}, IngestSeq ${order}
        LIMIT {limit:UInt32}`,
      params,
    ),
  );
  if (order === 'DESC') rows.reverse();
  const items = rows.map((r) => ({
    time: nanosToIso(r.ns),
    stream: r.stream || '',
    level: levelOf(r.severityText, r.severityNumber),
    message: r.body,
  }));
  return { items, nextSince: items.length ? items.at(-1).time : (since ?? nanosToIso(BigInt(now) * 1000000n)) };
}

/** Whether the agent's settings collect this container's logs. */
export function collectsLogs(settings, name) {
  const cl = settings?.collectors?.containerLogs;
  if (!cl?.enabled || cl.exclude?.includes(name)) return false;
  return !cl.include?.length || cl.include.includes(name);
}

/**
 * Turn log collection for one container on or off (PATCH /api/containers/:id/logs). On: the name leaves
 * `exclude`, joins `include` when the list names containers (an empty list already means all), and logs
 * are enabled. Off: the name leaves `include` and joins `exclude`; when that empties `include`, collection
 * is switched off instead (an empty include list would mean every container).
 */
export async function setContainerLogs(store, row, enabled) {
  const { agent, resource } = await requireServer(store, row.orgId, row.agentId);
  const setup = await configForAgent(store, agent);
  const settings = agentSettingsSchema.parse(setup.settings ?? {});
  const cl = { ...settings.collectors.containerLogs };
  const name = row.name;
  const without = (list) => list.filter((n) => n !== name);
  if (enabled) {
    cl.exclude = without(cl.exclude);
    if (!cl.enabled) {
      cl.enabled = true;
      cl.include = [name];
    } else if (cl.include.length && !cl.include.includes(name)) cl.include = [...cl.include, name];
  } else {
    if (!cl.exclude.includes(name)) cl.exclude = [...cl.exclude, name];
    if (cl.include.includes(name)) {
      cl.include = without(cl.include);
      if (!cl.include.length) cl.enabled = false;
    }
  }
  const next = agentSettingsSchema.parse({ ...settings, collectors: { ...settings.collectors, containerLogs: cl } });
  if (JSON.stringify(next.collectors.containerLogs) !== JSON.stringify(settings.collectors.containerLogs))
    await saveAgentSettings(store, agent, next, resource.name);
  return { enabled: collectsLogs(next, name), containerLogs: next.collectors.containerLogs };
}

// ---------------------------------------------------------------------------------------------- alerting

registerMetricSource('container_stopped', {
  label: 'Container stopped',
  kind: 'server',
  unit: 'containers',
  defaults: { operator: 'gt', threshold: 0, durationMinutes: 0, severity: 'warning' },
  available: async (store, orgId) => (await store.client.containerItem.count({ where: { orgId } })) > 0,
  format: (v) => `${v} container${v === 1 ? '' : 's'} stopped`,
  summary: (rule) =>
    `Alert me when a container stops on ${rule.scopeType === 'selected' ? `${rule.scopeIds?.length || 0} selected server${rule.scopeIds?.length === 1 ? '' : 's'}` : 'all servers'}.`,
  async evaluate(ctx, rule, { agent, resource }) {
    // A silent server is the "server stops reporting" rule's business, not ours.
    if (!agent.lastSeen || ctx.now - new Date(agent.lastSeen).getTime() > FRESH_MS)
      return { fire: null, clear: null, value: null };
    const stopped = await ctx.store.client.containerItem.findMany({
      where: { agentId: agent.id, wasRunning: true, state: 'stopped', stoppedStreak: { gte: STOPPED_INGESTS } },
      orderBy: { name: 'asc' },
    });
    const names = stopped.map((c) => c.name);
    return {
      fire: stopped.length > 0,
      clear: stopped.length === 0,
      value: stopped.length,
      detail: stopped.length
        ? `Stopped on ${resource.name}: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}.`
        : undefined,
    };
  },
});
