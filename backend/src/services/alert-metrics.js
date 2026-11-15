import { daysLeft } from './checks.js';

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

/** Windowed check over stored server samples: "for 5 minutes" means every sample in the window breaches. */
async function windowedServer(ctx, rule, subject, column) {
  const test = compare(rule);
  const windowMs = rule.durationSeconds * 1000;
  const from = new Date(ctx.now - Math.max(windowMs, MINUTE));
  const rows = await ctx.store.client.serverMetric.findMany({
    where: {
      agentId: subject.agent.id,
      time: { gte: from, lte: new Date(ctx.now) },
      [column]: { not: null },
    },
    orderBy: { time: 'asc' },
    select: { time: true, [column]: true },
  });
  const last = rows.at(-1);
  if (!last || ctx.now - last.time.getTime() > FRESH_MS) return { fire: null, clear: null, value: null };
  const value = last[column];
  // Recovery looks at the latest minute only, so one dip inside the window does not keep an alert open.
  const recent = rows.filter((r) => r.time.getTime() >= ctx.now - MINUTE);
  const clear = recent.length > 0 && recent.every((r) => !test(r[column]));
  if (windowMs === 0) return { fire: test(value), clear: !test(value), value };
  const covered = rows[0].time.getTime() <= ctx.now - windowMs + COVERAGE_MS;
  const allBreach = rows.every((r) => test(r[column]));
  // All samples breach but the window is not fully covered yet: not enough evidence either way.
  return { fire: allBreach ? (covered ? true : null) : false, clear, value };
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
