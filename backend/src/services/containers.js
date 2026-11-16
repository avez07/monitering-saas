import { assert } from '../lib/errors.js';
import { entitlements } from './limits.js';
import { retentionCutoff } from './metrics.js';
import { liveServers } from './servers.js';
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
  return new Map(live.map(({ agent, resource }) => [agent.id, { name: resource.name, hostname: agent.name, kind: agent.kind || 'server' }]));
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
  return { ...containerToApi(row, server), events: events.map(eventToApi) };
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
