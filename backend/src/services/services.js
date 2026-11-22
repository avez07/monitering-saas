import { assert } from '../lib/errors.js';
import { registerMetricSource } from './alert-metrics.js';
import { serviceHealth } from './service-health.js';
import { recordStateEvent, serverNames, eventToApi, STOPPED_INGESTS } from './containers.js';
import { configForAgent } from './agent-config.js';

export const SERVICE_KINDS = ['systemd', 'process', 'port', 'nginx', 'apache', 'mysql', 'postgres', 'mssql', 'redis'];
export const SERVICE_STATES = ['running', 'stopped', 'failed', 'unknown'];
export const SERVICE_GONE_AFTER_MS = 15 * 60000; // a service removed from the config disappears after this
const FRESH_MS = 150000;
/** Display grouping used by the dashboard (`type`); `kind` is the exact collector. */
const TYPE_GROUP = { nginx: 'web', apache: 'web', mysql: 'database', postgres: 'database', mssql: 'database', redis: 'cache' };
const isDown = (state) => state === 'stopped' || state === 'failed';

/** Apply one service snapshot from an agent (see recordContainers for the idempotency rule). */
export async function recordServices(store, agent, services, { reportedAt, now = Date.now() }) {
  const db = store.client;
  const at = new Date(now);
  const rows = await db.serviceItem.findMany({ where: { agentId: agent.id } });
  const byKey = new Map(rows.map((r) => [`${r.kind}:${r.name}`, r]));
  const seen = new Set();
  const base = { orgId: agent.orgId, agentId: agent.id };

  for (const s of new Map(services.map((x) => [`${x.kind}:${x.name}`, x])).values()) {
    const key = `${s.kind}:${s.name}`;
    seen.add(key);
    const existing = byKey.get(key);
    const fields = {
      state: s.state,
      detail: s.detail ?? '',
      responseMs: s.responseMs ?? null,
      port: s.port ?? null,
      lastSeen: at,
      reportedAt,
    };
    const event = (id, type, message) =>
      recordStateEvent(store, { ...base, subjectType: 'service', subjectId: id, subjectName: s.name, type, message });
    if (!existing) {
      const item = await db.serviceItem.create({
        data: { ...base, name: s.name, kind: s.kind, ...fields, stoppedStreak: isDown(s.state) ? 1 : 0, firstSeen: at, stateChangedAt: at },
      });
      await event(item.id, 'appeared', `Service ${s.name} appeared (${s.state}).`);
      continue;
    }
    if (existing.reportedAt >= reportedAt) continue;
    const changed = existing.state !== s.state;
    if (changed && s.state === 'running') await event(existing.id, 'recovered', `Service ${s.name} is running.`);
    if (changed && s.state === 'stopped') await event(existing.id, 'stopped', `Service ${s.name} stopped.`);
    if (changed && s.state === 'failed') await event(existing.id, 'failed', `Service ${s.name} failed.`);
    await db.serviceItem.update({
      where: { id: existing.id },
      data: { ...fields, stoppedStreak: isDown(s.state) ? existing.stoppedStreak + 1 : 0, ...(changed ? { stateChangedAt: at } : {}) },
    });
  }
  // Services dropped from the agent's configuration stop being reported; forget them after a while.
  const gone = rows.filter((r) => !seen.has(`${r.kind}:${r.name}`) && now - r.lastSeen.getTime() >= SERVICE_GONE_AFTER_MS);
  if (gone.length) await db.serviceItem.deleteMany({ where: { id: { in: gone.map((g) => g.id) } } });
  // `pending`: rows the snapshot no longer mentions and that are still waiting to expire.
  return { pending: rows.some((r) => !seen.has(`${r.kind}:${r.name}`) && !gone.includes(r)) };
}

export function serviceToApi(s, server) {
  return {
    id: s.id,
    serverId: s.agentId,
    serverName: server?.name ?? null,
    name: s.name,
    kind: s.kind,
    type: TYPE_GROUP[s.kind] ?? s.kind,
    state: s.state,
    detail: s.detail,
    responseMs: s.responseMs,
    port: s.port,
    firstSeen: s.firstSeen,
    lastSeen: s.lastSeen,
    lastChecked: s.lastSeen,
    stateChangedAt: s.stateChangedAt,
    health: serviceHealth(s, server),
  };
}

export async function listServices(store, orgId, { serverId, kind, state, search } = {}) {
  const servers = await serverNames(store, orgId);
  const live = { in: [...servers.keys()] };
  const where = { orgId, agentId: serverId ? serverId : live };
  if (kind) where.kind = kind;
  if (state) where.state = state;
  if (search) where.name = { contains: search, mode: 'insensitive' };
  const rows = await store.client.serviceItem.findMany({ where, orderBy: [{ name: 'asc' }, { kind: 'asc' }] });
  const grouped = await store.client.serviceItem.groupBy({ by: ['state'], where: { orgId, agentId: live }, _count: true });
  const summary = Object.fromEntries(SERVICE_STATES.map((s) => [s, 0]));
  for (const g of grouped) summary[g.state] = g._count;
  summary.total = SERVICE_STATES.reduce((a, s) => a + summary[s], 0);
  return { items: rows.filter((r) => servers.has(r.agentId)).map((r) => serviceToApi(r, servers.get(r.agentId))), summary };
}

export async function serviceDetail(store, orgId, id) {
  const row = /^[0-9a-f-]{36}$/.test(id) ? await store.client.serviceItem.findFirst({ where: { id, orgId } }) : null;
  const servers = await serverNames(store, orgId);
  assert(row && servers.has(row.agentId), 404, 'Service not found.');
  const events = await store.client.stateEvent.findMany({
    where: { subjectType: 'service', subjectId: row.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return { ...serviceToApi(row, servers.get(row.agentId)), ...(await configuredFields(store, orgId, row)), events: events.map(eventToApi) };
}

/** What the host's config says about this service (for editing): address, status URL, credentials reference. Never a secret. */
async function configuredFields(store, orgId, row) {
  try {
    const agent = await store.client.agent.findFirst({ where: { id: row.agentId, orgId } });
    if (!agent) return {};
    const services = (await configForAgent(store, agent)).settings?.collectors?.services ?? [];
    const entry = services.find((s) => s.kind === row.kind && s.name === row.name);
    if (!entry) return {};
    return {
      ...(entry.host ? { address: entry.host } : {}),
      ...(entry.url ? { url: entry.url } : {}),
      ...(entry.credentialsRef ? { credentialsRef: entry.credentialsRef } : {}),
    };
  } catch (error) {
    console.error('service detail: config not read:', error?.message);
    return {};
  }
}

registerMetricSource('service_stopped', {
  label: 'Service stopped',
  kind: 'server',
  unit: 'services',
  defaults: { operator: 'gt', threshold: 0, durationMinutes: 0, severity: 'warning' },
  available: async (store, orgId) => (await store.client.serviceItem.count({ where: { orgId } })) > 0,
  format: (v) => `${v} service${v === 1 ? '' : 's'} stopped`,
  summary: (rule) =>
    `Alert me when a service stops on ${rule.scopeType === 'selected' ? `${rule.scopeIds?.length || 0} selected server${rule.scopeIds?.length === 1 ? '' : 's'}` : 'all servers'}.`,
  async evaluate(ctx, rule, { agent, resource }) {
    if (!agent.lastSeen || ctx.now - new Date(agent.lastSeen).getTime() > FRESH_MS)
      return { fire: null, clear: null, value: null };
    const down = await ctx.store.client.serviceItem.findMany({
      where: { agentId: agent.id, state: { in: ['stopped', 'failed'] }, stoppedStreak: { gte: STOPPED_INGESTS } },
      orderBy: { name: 'asc' },
    });
    const names = down.map((s) => `${s.name} (${s.kind})`);
    return {
      fire: down.length > 0,
      clear: down.length === 0,
      value: down.length,
      detail: down.length
        ? `Stopped on ${resource.name}: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}.`
        : undefined,
    };
  },
});
