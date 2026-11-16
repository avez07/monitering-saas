import { Router } from 'express';
import { z } from 'zod';
import { HttpError, assert } from '../lib/errors.js';
import { config } from '../config.js';
import { canAdmin, audit } from '../services/auth.js';
import { entitlements } from '../services/limits.js';
import { select, tables } from '../lib/clickhouse.js';
import { redactionSchema } from '../services/otel-redact.js';
import { samplingSchema, normalizeSampling } from '../services/otel-sampling.js';
import { SEVERITY_LEVELS, SEVERITY_MIN_NUMBER, levelOfSeverityNumber } from '../services/otel-transform.js';
import { readUsage, quotaBytes, retentionDays, PLAN_RETENTION_DAYS } from '../services/otel-usage.js';
import { listTelemetryKeys, readSeen } from '../services/otel-auth.js';
import { clearOtelSettingsCache } from '../queues/otel.js';
import { randomUUID } from 'node:crypto';

const RANGES = { '15m': 15 * 60e3, '1h': 3600e3, '6h': 6 * 3600e3, '24h': 86400e3, '3d': 3 * 86400e3, '7d': 7 * 86400e3, '15d': 15 * 86400e3, '30d': 30 * 86400e3 };
const BUCKETS = [60, 300, 900, 1800, 3600, 10800, 21600, 86400];
const IDLE_MS = 10 * 60e3;
const KIND_WORD = { Unspecified: 'unspecified', Internal: 'internal', Server: 'server', Client: 'client', Producer: 'producer', Consumer: 'consumer' };
const ENTRY = "(ParentSpanId = '' OR SpanKind IN ('Server', 'Consumer'))";

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const round = (v, digits = 2) => (v === null || Number.isNaN(v) ? null : Math.round(v * 10 ** digits) / 10 ** digits);
const nsToMs = (v) => round(Number(v) / 1e6);
const isoFromNs = (ns) => new Date(Number(BigInt(ns) / 1000000n)).toISOString();
const bucketFor = (spanMs, maxPoints) => BUCKETS.find((b) => spanMs / 1000 / b <= maxPoints) ?? BUCKETS.at(-1);

const rangeQuery = z.object({
  range: z.enum(Object.keys(RANGES)).default('1h'),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});
const attrList = z.preprocess((v) => (v === undefined ? [] : [].concat(v)), z.array(z.string().max(400)).max(5));
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().datetime({ offset: true }).optional(),
});

/** Time window of a request, clamped to the plan's retention. */
function windowOf(query, days, now = Date.now()) {
  const q = rangeQuery.parse(query);
  let to = q.to ? Date.parse(q.to) : now;
  let from = q.from ? Date.parse(q.from) : to - RANGES[q.range];
  assert(from < to, 400, 'from must be before to.');
  const floor = now - days * 86400e3;
  const clamped = from < floor;
  if (clamped) from = floor;
  if (to <= from) to = from + 1000;
  return { from, to, clamped, spanMs: to - from, range: q.range };
}
const winParams = (w) => ({ fromMs: w.from, toMs: w.to, fromS: Math.floor(w.from / 1000), toS: Math.ceil(w.to / 1000) });
const TS = 'Timestamp >= fromUnixTimestamp64Milli({fromMs:Int64}) AND Timestamp <= fromUnixTimestamp64Milli({toMs:Int64})';
const MINUTE_RANGE = 'Minute >= toDateTime({fromS:Int64}) AND Minute <= toDateTime({toS:Int64})';

function attributeFilter(values, maps, params) {
  const clauses = [];
  values.forEach((raw, i) => {
    const at = raw.indexOf('=');
    assert(at > 0, 400, 'attribute must look like key=value.');
    params[`ak${i}`] = raw.slice(0, at);
    params[`av${i}`] = raw.slice(at + 1);
    clauses.push(`(${maps.map((m) => `${m}[{ak${i}:String}] = {av${i}:String}`).join(' OR ')})`);
  });
  return clauses;
}

const statusWord = (errorPercent, lastMs, now) => {
  if (lastMs === null || now - lastMs > IDLE_MS) return 'idle';
  if (errorPercent >= 5) return 'failing';
  if (errorPercent >= 1) return 'degraded';
  return 'healthy';
};
const redStats = (row, w) => {
  const requests = Number(row.requests) || 0;
  const errors = Number(row.errors) || 0;
  const [p50, p95, p99] = (row.q ?? []).map((v) => (Number.isFinite(Number(v)) ? nsToMs(v) : null));
  return {
    requests,
    ratePerSecond: round(requests / (w.spanMs / 1000), 3),
    errors,
    errorPercent: requests ? round((errors / requests) * 100) : 0,
    p50Ms: requests ? p50 : null,
    p95Ms: requests ? p95 : null,
    p99Ms: requests ? p99 : null,
  };
};

/** Run ClickHouse work; storage trouble becomes a 503 instead of a 500. */
async function guarded(work) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpError || error.name === 'ZodError') throw error;
    console.error('apps query failed:', error.message);
    throw new HttpError(503, 'Telemetry storage is unavailable. Try again shortly.');
  }
}

const RULE_IDS = (rules) => rules.map((r) => ({ ...r, id: r.id || randomUUID().slice(0, 8) }));

/** Dashboard API for OpenTelemetry data (PLAN_2 D.3). Session auth, org-scoped, read-only except settings. */
export function appsRoutes(store) {
  const router = Router();
  const org = (req) => req.context.orgId;
  const planOf = async (req) => (await entitlements(store, org(req))).plan;

  // --------------------------------------------------------------------------------- services list
  async function serviceRows(orgId, w, { name } = {}) {
    const params = { org: orgId, ...winParams(w), ...(name ? { name } : {}) };
    const byName = name ? 'AND ServiceName = {name:String}' : '';
    return select(
      `SELECT ServiceName AS name, sum(Requests) AS requests, sum(Errors) AS errors,
              quantilesTDigestMerge(0.5, 0.95, 0.99)(DurationState) AS q, toUnixTimestamp(max(Minute)) AS last
         FROM ${tables.red}
        WHERE OrgId = {org:String} AND ${MINUTE_RANGE} ${byName}
        GROUP BY ServiceName`,
      params,
    );
  }

  router.get('/apps/services', async (req, res) => {
    const plan = await planOf(req);
    const w = windowOf(req.query, retentionDays(plan.id));
    const bucket = bucketFor(w.spanMs, 30);
    const orgId = org(req);
    const now = Date.now();
    const out = await guarded(async () => {
      const params = { org: orgId, ...winParams(w), bucket };
      const [rows, buckets, known, logs] = await Promise.all([
        serviceRows(orgId, w),
        select(
          `SELECT ServiceName AS name, intDiv(toUnixTimestamp(Minute), {bucket:UInt32}) * {bucket:UInt32} AS t,
                  sum(Requests) AS requests, sum(Errors) AS errors, quantilesTDigestMerge(0.5, 0.95, 0.99)(DurationState) AS q
             FROM ${tables.red} WHERE OrgId = {org:String} AND ${MINUTE_RANGE} GROUP BY name, t ORDER BY t`,
          params,
        ),
        select(`SELECT ServiceName AS name, toUnixTimestamp(max(Minute)) AS last FROM ${tables.red} WHERE OrgId = {org:String} GROUP BY ServiceName`, params),
        select(`SELECT ServiceName AS name, count() AS c FROM ${tables.logs} WHERE OrgId = {org:String} AND ${TS} GROUP BY ServiceName`, params),
      ]);
      return { rows, buckets, known, logs };
    });
    const lastOf = new Map(out.known.map((r) => [r.name, Number(r.last) * 1000]));
    const logCount = new Map(out.logs.map((r) => [r.name, Number(r.c)]));
    const stats = new Map(out.rows.map((r) => [r.name, r]));
    const names = new Set([...lastOf.keys(), ...logCount.keys()]);
    const slots = [];
    for (let t = Math.floor(w.from / 1000 / bucket) * bucket; t * 1000 <= w.to; t += bucket) slots.push(t);
    const series = new Map();
    for (const b of out.buckets) {
      if (!series.has(b.name)) series.set(b.name, new Map());
      series.get(b.name).set(Number(b.t), b);
    }
    const items = [...names].map((name) => {
      const row = stats.get(name) ?? { requests: 0, errors: 0, q: [] };
      const s = redStats(row, w);
      const lastMs = lastOf.get(name) ?? null;
      const mine = series.get(name);
      return {
        name,
        status: statusWord(s.errorPercent, lastMs, now),
        ...s,
        lastSeen: lastMs ? new Date(lastMs).toISOString() : null,
        hasTraces: lastOf.has(name),
        hasLogs: (logCount.get(name) ?? 0) > 0,
        sparkline: slots.map((t) => {
          const b = mine?.get(t);
          return { t: new Date(t * 1000).toISOString(), requests: Number(b?.requests) || 0, errors: Number(b?.errors) || 0, p95Ms: b ? nsToMs(b.q?.[1]) : null };
        }),
      };
    });
    items.sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name));
    res.json({ range: w.range, from: new Date(w.from).toISOString(), to: new Date(w.to).toISOString(), clamped: w.clamped, bucketSeconds: bucket, items });
  });

  // -------------------------------------------------------------------------------- service detail
  router.get('/apps/services/:name', async (req, res) => {
    const plan = await planOf(req);
    const w = windowOf(req.query, retentionDays(plan.id));
    const bucket = bucketFor(w.spanMs, 120);
    const orgId = org(req);
    const name = req.params.name;
    const params = { org: orgId, name, ...winParams(w), bucket };
    const now = Date.now();
    const data = await guarded(() =>
      Promise.all([
        serviceRows(orgId, w, { name }),
        select(
          `SELECT intDiv(toUnixTimestamp(Minute), {bucket:UInt32}) * {bucket:UInt32} AS t, sum(Requests) AS requests, sum(Errors) AS errors,
                  quantilesTDigestMerge(0.5, 0.95, 0.99)(DurationState) AS q
             FROM ${tables.red} WHERE OrgId = {org:String} AND ServiceName = {name:String} AND ${MINUTE_RANGE} GROUP BY t ORDER BY t`,
          params,
        ),
        select(
          `SELECT SpanName AS endpoint, count() AS requests, countIf(StatusCode = 'Error') AS errors, avg(Duration) AS avgNs,
                  quantileTDigest(0.95)(Duration) AS p95Ns
             FROM ${tables.traces}
            WHERE OrgId = {org:String} AND ServiceName = {name:String} AND ${TS} AND ${ENTRY}
            GROUP BY SpanName ORDER BY requests DESC LIMIT 500`,
          params,
        ),
        select(
          `SELECT if(etype != '', etype, 'Error') AS type, argMax(if(emsg != '', emsg, StatusMessage), Timestamp) AS message,
                  count() AS count, toUnixTimestamp64Milli(max(Timestamp)) AS lastMs, argMax(TraceId, Timestamp) AS sampleTraceId
             FROM (
               SELECT Timestamp, TraceId, StatusMessage,
                      arrayFirst(x -> x != '', arrayMap((a, n) -> if(n = 'exception', a['exception.type'], ''), \`Events.Attributes\`, \`Events.Name\`)) AS etype,
                      arrayFirst(x -> x != '', arrayMap((a, n) -> if(n = 'exception', a['exception.message'], ''), \`Events.Attributes\`, \`Events.Name\`)) AS emsg
                 FROM ${tables.traces}
                WHERE OrgId = {org:String} AND ServiceName = {name:String} AND ${TS} AND StatusCode = 'Error')
            GROUP BY type ORDER BY count DESC LIMIT 10`,
          params,
        ),
        select(`SELECT toUnixTimestamp(max(Minute)) AS last FROM ${tables.red} WHERE OrgId = {org:String} AND ServiceName = {name:String}`, params),
        select(`SELECT count() AS c FROM ${tables.logs} WHERE OrgId = {org:String} AND ServiceName = {name:String} AND ${TS}`, params),
      ]),
    );
    const [rows, series, endpoints, errors, last, logs] = data;
    const lastSec = Number(last[0]?.last) || 0;
    assert(rows.length || lastSec || Number(logs[0]?.c), 404, 'No data for this service in the selected window.');
    const s = redStats(rows[0] ?? { requests: 0, errors: 0, q: [] }, w);
    const lastMs = lastSec ? lastSec * 1000 : null;
    const endpointItems = endpoints.map((e) => ({
      endpoint: e.endpoint,
      requests: Number(e.requests),
      errors: Number(e.errors),
      errorPercent: round((Number(e.errors) / Number(e.requests)) * 100),
      avgMs: nsToMs(e.avgNs),
      p95Ms: nsToMs(e.p95Ns),
    }));
    res.json({
      service: {
        name,
        status: statusWord(s.errorPercent, lastMs, now),
        ...s,
        lastSeen: lastMs ? new Date(lastMs).toISOString() : null,
        hasTraces: Boolean(lastSec),
        hasLogs: Number(logs[0]?.c) > 0,
      },
      range: w.range,
      from: new Date(w.from).toISOString(),
      to: new Date(w.to).toISOString(),
      clamped: w.clamped,
      bucketSeconds: bucket,
      series: series.map((b) => {
        const requests = Number(b.requests);
        const errors = Number(b.errors);
        return {
          t: new Date(Number(b.t) * 1000).toISOString(),
          requests,
          ratePerSecond: round(requests / bucket, 3),
          errors,
          errorPercent: requests ? round((errors / requests) * 100) : 0,
          p50Ms: nsToMs(b.q[0]),
          p95Ms: nsToMs(b.q[1]),
          p99Ms: nsToMs(b.q[2]),
        };
      }),
      topEndpoints: {
        slowest: [...endpointItems].sort((a, b) => b.p95Ms - a.p95Ms).slice(0, 10),
        mostErrors: endpointItems.filter((e) => e.errors > 0).sort((a, b) => b.errors - a.errors).slice(0, 10),
      },
      errors: errors.map((e) => ({
        type: e.type,
        message: e.message,
        count: Number(e.count),
        lastSeen: new Date(Number(e.lastMs)).toISOString(),
        sampleTraceId: e.sampleTraceId,
      })),
    });
  });

  // ------------------------------------------------------------------------------------ trace search
  const tracesQuery = listQuery.extend({
    service: z.string().max(200).optional(),
    endpoint: z.string().max(512).optional(),
    status: z.enum(['ok', 'error']).optional(),
    minDurationMs: z.coerce.number().min(0).max(1e9).optional(),
    attribute: attrList,
  });
  router.get('/apps/traces', async (req, res) => {
    const plan = await planOf(req);
    const q = tracesQuery.parse(req.query);
    const w = windowOf(req.query, retentionDays(plan.id));
    const params = { org: org(req), ...winParams(w), limit: q.limit + 1 };
    const filters = [];
    if (q.service) {
      filters.push('ServiceName = {service:String}');
      params.service = q.service;
    }
    if (q.endpoint) {
      filters.push('SpanName = {endpoint:String}');
      params.endpoint = q.endpoint;
    }
    if (q.status === 'error') filters.push("StatusCode = 'Error'");
    filters.push(...attributeFilter(q.attribute, ['SpanAttributes', 'ResourceAttributes'], params));
    // With only a service (or nothing) to match, entry spans find the traces (millions of child spans are skipped).
    const spanLevel = Boolean(q.endpoint || q.status === 'error' || q.attribute.length);
    if (!spanLevel) filters.push(ENTRY);
    if (!spanLevel && !q.service && q.minDurationMs) {
      filters.push('Duration >= {minNs:UInt64}');
      params.minNs = Math.floor(q.minDurationMs * 1e6);
    }
    const having = ['spanCount > 0'];
    if (q.status === 'ok') having.push('errorCount = 0');
    if (q.minDurationMs) {
      having.push('durationNs >= {minNs2:Int64}');
      params.minNs2 = Math.floor(q.minDurationMs * 1e6);
    }
    if (q.before) {
      having.push('startMs < {beforeMs:Int64}');
      params.beforeMs = Date.parse(q.before);
    }
    const rows = await guarded(() =>
      select(
        `SELECT TraceId AS traceId, toUnixTimestamp64Milli(min(Timestamp)) AS startMs,
                max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)) - min(toUnixTimestamp64Nano(Timestamp)) AS durationNs,
                count() AS spanCount, countIf(StatusCode = 'Error') AS errorCount,
                argMinIf(ServiceName, Timestamp, ParentSpanId = '') AS rootService, argMinIf(SpanName, Timestamp, ParentSpanId = '') AS rootName,
                argMin(ServiceName, Timestamp) AS firstService, argMin(SpanName, Timestamp) AS firstName,
                groupUniqArray(ServiceName) AS services
           FROM ${tables.traces}
          WHERE OrgId = {org:String} AND Timestamp >= fromUnixTimestamp64Milli({fromMs:Int64}) - toIntervalHour(1)
            AND Timestamp <= fromUnixTimestamp64Milli({toMs:Int64}) + toIntervalHour(1)
            AND TraceId IN (
              SELECT TraceId FROM ${tables.traces}
               WHERE OrgId = {org:String} AND ${TS} AND ${filters.join(' AND ')}
               GROUP BY TraceId ORDER BY max(Timestamp) DESC LIMIT 1000)
          GROUP BY TraceId
         HAVING ${having.join(' AND ')}
          ORDER BY startMs DESC LIMIT {limit:UInt32}`,
        params,
      ),
    );
    const page = rows.slice(0, q.limit);
    res.json({
      items: page.map((r) => ({
        traceId: r.traceId,
        startTime: new Date(Number(r.startMs)).toISOString(),
        durationMs: nsToMs(r.durationNs),
        rootService: r.rootService || r.firstService,
        rootName: r.rootName || r.firstName,
        spanCount: Number(r.spanCount),
        errorCount: Number(r.errorCount),
        services: [...r.services].sort(),
      })),
      hasMore: rows.length > q.limit,
    });
  });

  // ------------------------------------------------------------------------------------- trace by id
  const logOut = (r) => ({
    id: String(r.seq),
    timestamp: isoFromNs(r.ns),
    severity: SEVERITY_LEVELS[levelOfSeverityNumber(Number(r.severityNumber)) - 1] ?? 'info',
    severityNumber: Number(r.severityNumber),
    service: r.service,
    body: r.body,
    traceId: r.traceId || null,
    spanId: r.spanId || null,
    attributes: r.attributes,
    resourceAttributes: r.resourceAttributes,
  });
  const LOG_COLUMNS = `toString(toUnixTimestamp64Nano(Timestamp)) AS ns, IngestSeq AS seq, SeverityNumber AS severityNumber, ServiceName AS service,
        Body AS body, TraceId AS traceId, SpanId AS spanId, LogAttributes AS attributes, ResourceAttributes AS resourceAttributes`;

  router.get('/apps/traces/:traceId', async (req, res) => {
    const traceId = req.params.traceId.toLowerCase();
    assert(/^[0-9a-f]{32}$/.test(traceId), 404, 'Trace not found.');
    const params = { org: org(req), traceId };
    const [spans, logs] = await guarded(() =>
      Promise.all([
        select(
          `SELECT toString(toUnixTimestamp64Nano(Timestamp)) AS ns, SpanId AS spanId, ParentSpanId AS parentSpanId, SpanName AS name,
                  ServiceName AS service, SpanKind AS kind, Duration AS duration, StatusCode AS status, StatusMessage AS statusMessage,
                  SpanAttributes AS attributes, ResourceAttributes AS resourceAttributes, ScopeName AS scope,
                  arrayMap(t -> toString(toUnixTimestamp64Nano(t)), \`Events.Timestamp\`) AS eventNs, \`Events.Name\` AS eventNames,
                  \`Events.Attributes\` AS eventAttributes, \`Links.TraceId\` AS linkTraceIds, \`Links.SpanId\` AS linkSpanIds,
                  \`Links.Attributes\` AS linkAttributes
             FROM ${tables.traces} WHERE OrgId = {org:String} AND TraceId = {traceId:String} ORDER BY Timestamp, SpanId LIMIT 5000`,
          params,
        ),
        select(`SELECT ${LOG_COLUMNS} FROM ${tables.logs} WHERE OrgId = {org:String} AND TraceId = {traceId:String} ORDER BY Timestamp LIMIT 200`, params),
      ]),
    );
    assert(spans.length, 404, 'Trace not found.');
    const t0 = spans.reduce((m, s) => (BigInt(s.ns) < m ? BigInt(s.ns) : m), BigInt(spans[0].ns));
    const end = spans.reduce((m, s) => (BigInt(s.ns) + BigInt(s.duration) > m ? BigInt(s.ns) + BigInt(s.duration) : m), t0);
    const offset = (ns) => Number(BigInt(ns) - t0) / 1e6;
    const present = new Set(spans.map((s) => s.spanId));
    res.json({
      traceId,
      startTime: isoFromNs(t0.toString()),
      durationMs: round(Number(end - t0) / 1e6),
      spanCount: spans.length,
      errorCount: spans.filter((s) => s.status === 'Error').length,
      spans: spans.map((s) => ({
        spanId: s.spanId,
        // A parent that was never received (dropped, or sampled out) is shown as a root so the waterfall still renders.
        parentSpanId: s.parentSpanId && present.has(s.parentSpanId) ? s.parentSpanId : null,
        name: s.name,
        service: s.service,
        kind: KIND_WORD[s.kind] ?? 'unspecified',
        startTime: isoFromNs(s.ns),
        startOffsetMs: round(offset(s.ns), 3),
        durationMs: nsToMs(s.duration),
        status: s.status.toLowerCase(),
        statusMessage: s.statusMessage,
        attributes: s.attributes,
        resourceAttributes: s.resourceAttributes,
        scope: s.scope,
        events: s.eventNs.map((ns, i) => ({
          time: isoFromNs(ns),
          offsetMs: round(offset(ns), 3),
          name: s.eventNames[i],
          attributes: s.eventAttributes[i],
        })),
        links: s.linkTraceIds.map((id, i) => ({ traceId: id, spanId: s.linkSpanIds[i], attributes: s.linkAttributes[i] })),
      })),
      logs: logs.map(logOut).map(({ id, ...rest }) => rest),
    });
  });

  // --------------------------------------------------------------------------------------- logs
  const logsQuery = listQuery.extend({
    q: z.string().max(200).optional(),
    service: z.string().max(200).optional(),
    severity: z.enum(SEVERITY_LEVELS).optional(),
    traceId: z.string().regex(/^[0-9a-fA-F]{32}$/).optional(),
    attribute: attrList,
    after: z.string().regex(/^\d{1,20}$/).optional(),
  });
  router.get('/apps/logs', async (req, res) => {
    const plan = await planOf(req);
    const q = logsQuery.parse(req.query);
    const w = windowOf(req.query, retentionDays(plan.id));
    const params = { org: org(req), ...winParams(w), limit: q.limit + 1 };
    const filters = [];
    if (q.service) {
      filters.push('ServiceName = {service:String}');
      params.service = q.service;
    }
    if (q.severity && SEVERITY_MIN_NUMBER[q.severity] > 1) {
      filters.push('SeverityNumber >= {sev:UInt8}');
      params.sev = SEVERITY_MIN_NUMBER[q.severity];
    }
    if (q.traceId) {
      filters.push('TraceId = {traceId:String}');
      params.traceId = q.traceId.toLowerCase();
    }
    (q.q ?? '').split(/\s+/).filter(Boolean).slice(0, 5).forEach((term, i) => {
      filters.push(`positionCaseInsensitive(Body, {term${i}:String}) > 0`);
      params[`term${i}`] = term;
    });
    filters.push(...attributeFilter(q.attribute, ['LogAttributes', 'ResourceAttributes'], params));
    const where = `OrgId = {org:String} ${filters.map((f) => `AND ${f}`).join(' ')}`;
    if (q.after) {
      // Live tail: everything stored after the cursor, oldest first up to the cap, shown newest first.
      params.after = q.after;
      const rows = await guarded(() =>
        select(`SELECT ${LOG_COLUMNS} FROM ${tables.logs} WHERE ${where} AND IngestSeq > {after:UInt64} AND Timestamp >= fromUnixTimestamp64Milli({fromMs:Int64}) ORDER BY IngestSeq LIMIT 500`, params),
      );
      const cursor = rows.length ? String(rows.at(-1).seq) : q.after;
      return res.json({ items: rows.map(logOut).reverse(), hasMore: false, cursor });
    }
    if (q.before) {
      filters.push('Timestamp < fromUnixTimestamp64Milli({beforeMs:Int64})');
      params.beforeMs = Date.parse(q.before);
    }
    const [rows, top] = await guarded(() =>
      Promise.all([
        select(
          `SELECT ${LOG_COLUMNS} FROM ${tables.logs} WHERE OrgId = {org:String} AND ${TS} ${filters.map((f) => `AND ${f}`).join(' ')}
            ORDER BY Timestamp DESC, IngestSeq DESC LIMIT {limit:UInt32}`,
          params,
        ),
        select(`SELECT max(IngestSeq) AS seq FROM ${tables.logs} WHERE OrgId = {org:String} AND ${TS}`, params),
      ]),
    );
    res.json({ items: rows.slice(0, q.limit).map(logOut), hasMore: rows.length > q.limit, cursor: String(top[0]?.seq ?? '0') });
  });

  // ---------------------------------------------------------------------------------- connection
  router.get('/apps/connection', async (req, res) => {
    const keys = await listTelemetryKeys(store, org(req));
    const items = await Promise.all(
      keys.map(async (k) => ({ id: k.id, name: k.name, prefix: k.prefix, createdAt: k.createdAt, ...(await readSeen(k.id)) })),
    );
    res.json({
      otlpEndpoint: otlpEndpoint(),
      header: 'x-yuktiops-key',
      anyTraceSeen: items.some((k) => k.traceSeen),
      keys: items,
    });
  });

  // ---------------------------------------------------------------------------------- settings
  const otlpEndpoint = () => (process.env.OTLP_PUBLIC_URL || config.API_PUBLIC_URL).replace(/\/$/, '');
  async function settingsBody(req) {
    const plan = await planOf(req);
    const row = await store.client.telemetrySettings.findUnique({ where: { orgId: org(req) } });
    const usage = await readUsage(org(req));
    const limitBytes = quotaBytes(plan.id);
    return {
      redaction: { rules: Array.isArray(row?.redaction) ? row.redaction : [] },
      sampling: normalizeSampling(row?.sampling),
      retention: { days: retentionDays(plan.id), plan: plan.id, byPlan: PLAN_RETENTION_DAYS },
      usage: { ...usage, limitBytes, percent: Math.round((usage.bytes / limitBytes) * 10000) / 100 },
      otlpEndpoint: otlpEndpoint(),
    };
  }
  router.get('/apps/settings', async (req, res) => res.json(await settingsBody(req)));
  router.put('/apps/settings', canAdmin, async (req, res) => {
    const input = z
      .object({ redaction: redactionSchema.optional(), sampling: samplingSchema.partial().optional() })
      .parse(req.body);
    const orgId = org(req);
    const current = await store.client.telemetrySettings.findUnique({ where: { orgId } });
    const data = {
      ...(input.redaction ? { redaction: RULE_IDS(input.redaction.rules) } : {}),
      ...(input.sampling ? { sampling: samplingSchema.parse({ ...normalizeSampling(current?.sampling), ...input.sampling }) } : {}),
    };
    await store.client.telemetrySettings.upsert({
      where: { orgId },
      create: { orgId, ...data },
      update: data,
    });
    clearOtelSettingsCache();
    await audit(store, req.context, 'telemetry_settings.updated', Object.keys(data).join(', '));
    res.json(await settingsBody(req));
  });
  return router;
}
