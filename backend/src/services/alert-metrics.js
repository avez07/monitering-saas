import { daysLeft } from './checks.js';
import { select, tables } from '../lib/clickhouse.js';

/**
 * Metric-source registry. Each source turns "this rule applied to this thing" into
 *   { fire: true|false|null, clear: true|false|null, value, detail? }
 * `fire` says the condition has held long enough to open an incident, `clear` says an open incident
 * can start recovering, and `null` means "no data, change nothing".
 * Later phases (containers, services) call `registerMetricSource` to plug in their data.
 */
export const metricSources = new Map();
export function registerMetricSource(key, source) {
  metricSources.set(key, { key, ...source });
}

/**
 * Subject loaders for kinds beyond server/website: `kind -> async (store, orgId) => subjects[]`. A subject is
 * `{ kind, resource, ... }` where `resource` is a MonitoredResource row (incidents point at it). Loaded only
 * when an enabled rule of that kind exists, so a missing optional backend never slows other alerts.
 */
export const subjectLoaders = new Map();

const MINUTE = 60000;
const FRESH_MS = 150000; // a server sample older than this is "no data" (the offline rule covers it)
const COVERAGE_MS = 45000; // the window's first sample may start this late and still count as covered

const compare = (rule) =>
  rule.operator === 'lt' ? (v) => v < rule.threshold : (v) => v > rule.threshold;
const pct = (v) => `${Math.round(v * 10) / 10}%`;

/** Plain-language scope for summaries: "all servers", "2 selected servers". */
function scopeText(rule, kind) {
  const noun = kind === 'website' ? 'website' : 'server';
  if (rule.scopeType !== 'selected') return `all ${noun}s`;
  const n = rule.scopeIds?.length || 0;
  return `${n} selected ${noun}${n === 1 ? '' : 's'}`;
}
const minutesOf = (rule) => Math.round((rule.durationSeconds || 0) / 60);
const forText = (rule) => {
  const m = minutesOf(rule);
  return m > 0 ? ` for ${m} minute${m === 1 ? '' : 's'}` : '';
};

const SQL_COLUMN = { cpuPercent: 'cpu_percent', memPercent: 'mem_percent', diskPercent: 'disk_percent' };

/**
 * One SQL for a rule over all its servers: per agent, the window's first/last sample time, the latest
 * value, whether every sample breaches, and whether the last minute is entirely clear. Returns a Map
 * agentId -> aggregate, consumed by `windowedServer`.
 */
async function prepareWindowedServer(ctx, rule, subjects, column) {
  const col = SQL_COLUMN[column];
  const breach = rule.operator === 'lt' ? `${col} < $5` : `${col} > $5`;
  const windowMs = rule.durationSeconds * 1000;
  const rows = await ctx.store.client.$queryRawUnsafe(
    `SELECT agent_id,
            min(time) AS first_time,
            max(time) AS last_time,
            (array_agg(${col} ORDER BY time DESC))[1] AS last_value,
            bool_and(${breach}) AS all_breach,
            bool_and(NOT (${breach})) FILTER (WHERE time >= $4::timestamptz) AS recent_clear
       FROM server_metrics
      WHERE agent_id = ANY($1::text[])
        AND time >= $2::timestamptz AND time <= $3::timestamptz
        AND ${col} IS NOT NULL
      GROUP BY agent_id`,
    subjects.map((s) => s.agent.id),
    new Date(ctx.now - Math.max(windowMs, MINUTE)),
    new Date(ctx.now),
    new Date(ctx.now - MINUTE),
    rule.threshold,
  );
  return new Map(
    rows.map((r) => [
      r.agent_id,
      {
        firstTime: new Date(r.first_time).getTime(),
        lastTime: new Date(r.last_time).getTime(),
        value: r.last_value,
        allBreach: r.all_breach === true,
        recentClear: r.recent_clear === true,
      },
    ]),
  );
}

/** Windowed check over stored server samples: "for 5 minutes" means every sample in the window breaches. */
async function windowedServer(ctx, rule, subject, column) {
  const test = compare(rule);
  const windowMs = rule.durationSeconds * 1000;
  let agg = ctx.batch?.get(subject.agent.id);
  if (!ctx.batch) {
    // Single-subject fallback (no batch prepared): same aggregates from one agent's rows.
    const rows = await ctx.store.client.serverMetric.findMany({
      where: {
        agentId: subject.agent.id,
        time: { gte: new Date(ctx.now - Math.max(windowMs, MINUTE)), lte: new Date(ctx.now) },
        [column]: { not: null },
      },
      orderBy: { time: 'asc' },
      select: { time: true, [column]: true },
    });
    if (rows.length) {
      const recent = rows.filter((r) => r.time.getTime() >= ctx.now - MINUTE);
      agg = {
        firstTime: rows[0].time.getTime(),
        lastTime: rows.at(-1).time.getTime(),
        value: rows.at(-1)[column],
        allBreach: rows.every((r) => test(r[column])),
        recentClear: recent.length > 0 && recent.every((r) => !test(r[column])),
      };
    }
  }
  if (!agg || ctx.now - agg.lastTime > FRESH_MS) return { fire: null, clear: null, value: null };
  const value = agg.value;
  // Recovery looks at the latest minute only, so one dip inside the window does not keep an alert open.
  const clear = agg.recentClear;
  if (windowMs === 0) return { fire: test(value), clear: !test(value), value };
  const covered = agg.firstTime <= ctx.now - windowMs + COVERAGE_MS;
  // All samples breach but the window is not fully covered yet: not enough evidence either way.
  return { fire: agg.allBreach ? (covered ? true : null) : false, clear, value };
}

function serverMetric(key, label, noun, column, defaults) {
  registerMetricSource(key, {
    label,
    kind: 'server',
    unit: '%',
    defaults,
    available: async () => true,
    format: pct,
    summary: (rule) =>
      `Alert me when ${noun} is ${rule.operator === 'lt' ? 'below' : 'above'} ${rule.threshold}%${forText(rule)} on ${scopeText(rule, 'server')}.`,
    prepare: (ctx, rule, subjects) => prepareWindowedServer(ctx, rule, subjects, column),
    evaluate: (ctx, rule, subject) => windowedServer(ctx, rule, subject, column),
  });
}
serverMetric('cpu', 'CPU use', 'CPU use', 'cpuPercent', {
  operator: 'gt', threshold: 90, durationMinutes: 5, severity: 'warning',
});
serverMetric('memory', 'Memory used', 'memory used', 'memPercent', {
  operator: 'gt', threshold: 90, durationMinutes: 5, severity: 'warning',
});
serverMetric('disk', 'Disk space used', 'disk space used', 'diskPercent', {
  operator: 'gt', threshold: 85, durationMinutes: 5, severity: 'warning',
});

registerMetricSource('offline', {
  label: 'Server stops reporting',
  kind: 'server',
  unit: 'minutes',
  defaults: { operator: 'gt', threshold: 2, durationMinutes: 0, severity: 'critical' },
  available: async () => true,
  format: (v) => `${Math.round(v * 10) / 10} minutes without data`,
  summary: (rule) =>
    `Alert me when ${rule.scopeType === 'selected' ? `one of ${scopeText(rule, 'server')}` : 'any server'} stops reporting for ${rule.threshold} minute${rule.threshold === 1 ? '' : 's'}.`,
  async evaluate(ctx, rule, subject) {
    const { agent } = subject;
    if (!agent.lastSeen || agent.status === 'pending') return { fire: null, clear: null, value: null };
    const minutes = (ctx.now - new Date(agent.lastSeen).getTime()) / MINUTE;
    const fire = minutes > rule.threshold;
    return {
      fire,
      clear: !fire,
      value: minutes,
      detail: `${subject.resource.name} has sent no data for ${Math.floor(minutes)} minutes.`,
    };
  },
});

// Containers and services are collected in later phases; they register real sources over these.
for (const [key, label, noun] of [
  ['container_stopped', 'Container stopped', 'a container stops'],
  ['service_stopped', 'Service stopped', 'a service stops'],
])
  registerMetricSource(key, {
    label,
    kind: 'server',
    unit: '',
    defaults: { operator: 'gt', threshold: 0, durationMinutes: 0, severity: 'warning' },
    available: async () => false,
    format: (v) => String(v),
    summary: (rule) => `Alert me when ${noun} on ${scopeText(rule, 'server')}.`,
    evaluate: async () => ({ fire: null, clear: null, value: null }),
  });

registerMetricSource('website_down', {
  label: 'Website is down',
  kind: 'website',
  unit: '',
  defaults: { operator: 'gt', threshold: 0, durationMinutes: 0, severity: 'critical' },
  available: async () => true,
  format: (v) => (v ? 'down' : 'up'),
  summary: (rule) =>
    `Alert me when ${rule.scopeType === 'selected' ? `one of ${scopeText(rule, 'website')}` : 'a website'} is down${forText(rule)}.`,
  async evaluate(ctx, rule, { monitor }) {
    if (monitor.status === 'pending') return { fire: null, clear: null, value: null };
    const down = monitor.status === 'unhealthy';
    const downFor = down && monitor.downSince ? ctx.now - new Date(monitor.downSince).getTime() : 0;
    const fire = down && downFor >= rule.durationSeconds * 1000;
    return {
      fire,
      clear: !down,
      value: down ? 1 : 0,
      detail: `${monitor.name} is not responding${monitor.lastError ? ` (${monitor.lastError})` : ''}.`,
    };
  },
});

registerMetricSource('website_slow', {
  label: 'Website is slow',
  kind: 'website',
  unit: 'seconds',
  defaults: { operator: 'gt', threshold: 3, durationMinutes: 5, severity: 'warning' },
  available: async () => true,
  format: (v) => `${Math.round(v * 100) / 100} seconds`,
  summary: (rule) =>
    `Alert me when ${rule.scopeType === 'selected' ? `one of ${scopeText(rule, 'website')}` : 'a website'} takes longer than ${rule.threshold} seconds to respond${forText(rule)}.`,
  async evaluate(ctx, rule, { monitor }) {
    const slow = (c) => c.latencyMs > rule.threshold * 1000;
    const windowMs = rule.durationSeconds * 1000;
    const rows = await ctx.store.client.uptimeCheck.findMany({
      where: { monitorId: monitor.id, createdAt: { gte: new Date(ctx.now - Math.max(windowMs, 2 * MINUTE)), lte: new Date(ctx.now) } },
      orderBy: { createdAt: 'asc' },
    });
    const last = rows.at(-1);
    if (!last) return { fire: null, clear: null, value: null };
    const value = last.latencyMs / 1000;
    if (windowMs === 0) return { fire: slow(last), clear: !slow(last), value };
    const window = rows.filter((r) => r.createdAt.getTime() >= ctx.now - windowMs);
    const covered =
      window.length > 0 && window[0].createdAt.getTime() <= ctx.now - windowMs + monitor.intervalSeconds * 1000 + 15000;
    const allSlow = window.length > 0 && window.every(slow);
    return { fire: allSlow ? (covered ? true : null) : false, clear: !slow(last), value };
  },
});

for (const [key, label, noun, field, extra] of [
  ['ssl_days', 'SSL certificate expires soon', 'the SSL certificate', 'certificateExpiresAt', 'SSL certificate'],
  ['domain_days', 'Domain expires soon', 'the domain', 'domainExpiresAt', 'Domain'],
])
  registerMetricSource(key, {
    label,
    kind: 'website',
    unit: 'days',
    defaults: { operator: 'lt', threshold: 30, durationMinutes: 0, severity: 'warning' },
    available: async () => true,
    format: (v) => `${v} day${v === 1 ? '' : 's'} left`,
    summary: (rule) =>
      `Alert me when ${rule.scopeType === 'selected' ? `${noun} of one of ${scopeText(rule, 'website')}` : `${noun} of a website`} expires in less than ${rule.threshold} days.`,
    async evaluate(ctx, rule, { monitor }) {
      const days = daysLeft(monitor[field], ctx.now);
      if (days == null) return { fire: null, clear: null, value: null };
      const fire = compare(rule)(days);
      return { fire, clear: !fire, value: days, detail: `${extra} for ${monitor.name} expires in ${Math.max(days, 0)} days.` };
    },
  });


// ---- OpenTelemetry (apps): subjects are services seen in the per-minute RED rollup (ClickHouse). ----------------

subjectLoaders.set('app', async (store, orgId) => {
  const rows = await select(
    `SELECT ServiceName AS name FROM ${tables.red} WHERE OrgId = {org:String} GROUP BY ServiceName ORDER BY name LIMIT 500`,
    { org: orgId },
  );
  if (!rows.length) return [];
  const project = (await store.list('project', { orgId })).filter((p) => !p.deletedAt).sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!project) return [];
  const existing = new Map(
    (await store.client.monitoredResource.findMany({ where: { orgId, type: 'app' } })).map((r) => [r.externalId, r]),
  );
  const out = [];
  for (const { name } of rows) {
    const externalId = `app:${name}`;
    let resource = existing.get(externalId);
    if (!resource)
      resource = await store.create('monitoredResource', {
        orgId, projectId: project.id, name, externalId, type: 'app', environment: 'production', status: 'healthy', labels: {},
      });
    else if (resource.deletedAt) resource = await store.update('monitoredResource', resource.id, { deletedAt: null });
    out.push({ kind: 'app', service: name, resource });
  }
  return out;
});

const orgHasTelemetryKey = async (store, orgId) =>
  (await store.client.apiKey.count({ where: { orgId, kind: 'telemetry', revokedAt: null } })) > 0;
const appScope = (rule) =>
  rule.scopeType === 'selected'
    ? `${rule.scopeIds?.length || 0} selected service${rule.scopeIds?.length === 1 ? '' : 's'}`
    : 'any service';

/**
 * Per-minute buckets of every service for the rule's window, one query: service -> [{ minute, requests,
 * errors, p95 (ms) }]. Windowed rules fire only when every minute with traffic breaches and the window is covered.
 */
async function prepareAppMinutes(ctx, rule) {
  const windowMs = Math.max(rule.durationSeconds * 1000, MINUTE);
  const rows = await select(
    `SELECT ServiceName AS name, toUnixTimestamp(Minute) AS minute, sum(Requests) AS requests, sum(Errors) AS errors,
            quantilesTDigestMerge(0.5, 0.95, 0.99)(DurationState)[2] AS p95
       FROM ${tables.red}
      WHERE OrgId = {org:String} AND Minute >= toStartOfMinute(toDateTime({from:Int64})) AND Minute <= toDateTime({to:Int64})
      GROUP BY name, minute ORDER BY minute`,
    { org: ctx.orgId, from: Math.floor((ctx.now - windowMs) / 1000), to: Math.ceil(ctx.now / 1000) },
  );
  const byService = new Map();
  for (const r of rows) {
    if (!byService.has(r.name)) byService.set(r.name, []);
    byService.get(r.name).push({ minute: Number(r.minute) * 1000, requests: Number(r.requests), errors: Number(r.errors), p95: Number(r.p95) / 1e6 });
  }
  return byService;
}

/** Shared windowed evaluation for per-minute rate/latency rules. `valueOf(bucket)` is compared with the threshold. */
function windowedApp(ctx, rule, subject, valueOf, scale = 1) {
  const buckets = (ctx.batch?.get(subject.service) ?? []).filter((b) => b.requests > 0);
  const test = compare(rule);
  const latest = buckets.at(-1);
  // No traffic in the last two minutes: nothing to judge (the "no traces" rule covers silence).
  if (!latest || ctx.now - latest.minute > 2 * MINUTE) return { fire: null, clear: null, value: null };
  const windowMs = rule.durationSeconds * 1000;
  const value = valueOf(latest) / scale;
  if (windowMs === 0) return { fire: test(value), clear: !test(value), value };
  const inWindow = buckets.filter((b) => b.minute >= ctx.now - windowMs - MINUTE + 1);
  const allBreach = inWindow.length > 0 && inWindow.every((b) => test(valueOf(b) / scale));
  const covered = inWindow[0] && inWindow[0].minute <= ctx.now - windowMs; // the minute holding the window start has data
  const recent = buckets.filter((b) => b.minute >= ctx.now - MINUTE - 1);
  const clear = recent.length > 0 && recent.every((b) => !test(valueOf(b) / scale));
  return { fire: allBreach ? (covered ? true : null) : false, clear, value };
}

const appSource = (key, label, unit, defaults, extra) =>
  registerMetricSource(key, { label, kind: 'app', unit, defaults, available: orgHasTelemetryKey, ...extra });

appSource('app_error_rate', 'App error rate', '%', { operator: 'gt', threshold: 5, durationMinutes: 5, severity: 'critical' }, {
  format: pct,
  summary: (rule) => `Alert me when the error rate of ${appScope(rule)} is above ${rule.threshold}%${forText(rule)}.`,
  prepare: (ctx, rule) => prepareAppMinutes(ctx, rule),
  evaluate: async (ctx, rule, subject) => {
    const r = windowedApp(ctx, rule, subject, (b) => (b.errors / b.requests) * 100);
    return r.fire === true ? { ...r, detail: `${subject.service} is failing ${pct(r.value)} of its requests.` } : r;
  },
});
appSource('app_latency_p95', 'App p95 latency', 'seconds', { operator: 'gt', threshold: 1, durationMinutes: 5, severity: 'warning' }, {
  format: (v) => `${Math.round(v * 100) / 100} seconds`,
  summary: (rule) => `Alert me when the p95 latency of ${appScope(rule)} is above ${rule.threshold} seconds${forText(rule)}.`,
  prepare: (ctx, rule) => prepareAppMinutes(ctx, rule),
  evaluate: async (ctx, rule, subject) => {
    const r = windowedApp(ctx, rule, subject, (b) => b.p95, 1000);
    return r.fire === true ? { ...r, detail: `${subject.service} p95 latency is ${Math.round(r.value * 100) / 100} seconds.` } : r;
  },
});
appSource('app_no_traces', 'No traces received', 'minutes', { operator: 'gt', threshold: 10, durationMinutes: 0, severity: 'warning' }, {
  format: (v) => `${Math.round(v * 10) / 10} minutes without traces`,
  summary: (rule) => `Alert me when ${appScope(rule)} sends no traces for ${rule.threshold} minute${rule.threshold === 1 ? '' : 's'}.`,
  prepare: async (ctx) => {
    const rows = await select(
      `SELECT ServiceName AS name, toUnixTimestamp(max(Minute)) AS last FROM ${tables.red} WHERE OrgId = {org:String} GROUP BY name`,
      { org: ctx.orgId },
    );
    return new Map(rows.map((r) => [r.name, Number(r.last) * 1000]));
  },
  evaluate: async (ctx, rule, subject) => {
    const last = ctx.batch?.get(subject.service);
    if (!last) return { fire: null, clear: null, value: null };
    const minutes = Math.max(0, (ctx.now - last - MINUTE) / MINUTE); // `last` is the start of the minute
    const fire = minutes > rule.threshold;
    return { fire, clear: !fire, value: minutes, detail: `${subject.service} has sent no traces for ${Math.floor(minutes)} minutes.` };
  },
});

/** One-click rule templates. `kind` is derived from the metric. */
export const templates = [
  ['server_down', 'Server goes down', 'A server stops sending data for 2 minutes.', 'offline'],
  ['disk_almost_full', 'Disk almost full', 'Disk space is over 85% for 5 minutes.', 'disk'],
  ['cpu_very_high', 'CPU stays very high', 'CPU is over 90% for 5 minutes.', 'cpu'],
  ['memory_almost_full', 'Memory almost full', 'Memory is over 90% for 5 minutes.', 'memory'],
  ['website_down', 'Website is down', 'A website or API stops responding.', 'website_down'],
  ['website_slow', 'Website is slow', 'A website takes over 3 seconds to respond for 5 minutes.', 'website_slow'],
  ['ssl_expires_soon', 'SSL certificate expires soon', 'A certificate has less than 30 days left.', 'ssl_days'],
  ['domain_expires_soon', 'Domain expires soon', 'A domain has less than 30 days left.', 'domain_days'],
  ['container_stopped', 'Container stopped', 'A Docker container stops running.', 'container_stopped'],
  ['service_stopped', 'Service stopped', 'A system service stops running.', 'service_stopped'],
  ['app_error_rate', 'App error rate high', 'An app fails more than 5% of requests for 5 minutes.', 'app_error_rate'],
  ['app_latency_p95', 'App is slow', 'An app has a p95 latency above 1 second for 5 minutes.', 'app_latency_p95'],
  ['app_no_traces', 'No traces received', 'An app that was sending traces sends none for 10 minutes.', 'app_no_traces'],
].map(([key, name, description, metric]) => ({ key, name, description, metric }));

export const DEFAULT_TEMPLATE_KEYS = ['server_down', 'disk_almost_full', 'website_down'];
export const DEFAULT_COOLDOWN_MINUTES = 30;

/** Turn a rule's plain input (minutes, scope) into stored columns, filling gaps from the metric defaults. */
export function normalizeRule(input, existing = {}) {
  const source = metricSources.get(input.metric ?? existing.metric);
  const d = source.defaults;
  const scope = input.scope ?? {
    type: existing.scopeType ?? 'all',
    ids: existing.scopeIds ?? [],
  };
  const minutes =
    input.durationMinutes ?? (existing.durationSeconds != null ? existing.durationSeconds / 60 : d.durationMinutes);
  return {
    metric: source.key,
    operator: input.operator ?? existing.operator ?? d.operator,
    threshold: input.threshold ?? existing.threshold ?? d.threshold,
    durationSeconds: Math.round(minutes * 60),
    cooldownSeconds: Math.round(
      (input.cooldownMinutes ?? (existing.cooldownSeconds != null ? existing.cooldownSeconds / 60 : DEFAULT_COOLDOWN_MINUTES)) * 60,
    ),
    severity: input.severity ?? existing.severity ?? d.severity,
    scopeType: scope.type,
    scopeIds: scope.type === 'selected' ? scope.ids : [],
    contactIds: input.contactIds ?? existing.contactIds ?? [],
  };
}

export const ruleSummary = (rule) => metricSources.get(rule.metric)?.summary(rule) ?? rule.name;
