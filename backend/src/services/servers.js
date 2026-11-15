import { assert } from '../lib/errors.js';
import { entitlements } from './limits.js';
import { retentionCutoff } from './metrics.js';
import { agentSettingsSchema, configForAgent, newConfigId } from './agent-config.js';

const MIN_ONLINE_MS = 90000;
export const RANGES = {
  '1h': { ms: 3600000, source: 'raw', bucketSeconds: null },
  '24h': { ms: 86400000, source: '5m', bucketSeconds: 300 },
  '7d': { ms: 7 * 86400000, source: '1h', bucketSeconds: 3600 },
  '30d': { ms: 30 * 86400000, source: '1h', bucketSeconds: 3600 },
};

/** A server counts as online while data arrived within three send intervals (at least 90 seconds). */
export const onlineWindowMs = (settings) =>
  Math.max(MIN_ONLINE_MS, 3 * (settings?.sendIntervalSeconds ?? 30) * 1000);

export function serverStatus(agent, settings, now = Date.now()) {
  if (agent.status === 'pending') return 'never_connected';
  if (agent.status === 'revoked') return 'offline';
  return now - new Date(agent.lastSeen).getTime() <= onlineWindowMs(settings) ? 'online' : 'offline';
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function serverSummary(agent, resource, settings, now = Date.now()) {
  const status = serverStatus(agent, settings, now);
  const l = resource.labels || {};
  return {
    id: agent.id,
    resourceId: resource.id,
    name: resource.name,
    hostname: agent.name,
    os: agent.os || l.os || '',
    arch: agent.arch,
    platform: agent.platform,
    agentVersion: agent.version,
    status,
    lastSeen: status === 'never_connected' ? null : agent.lastSeen,
    cpu: num(l.cpu),
    memory: num(l.memory),
    disk: num(l.disk),
    uptimeSeconds: num(l.uptimeSeconds),
    cores: num(l.cores),
    ramGb: num(l.ramGb),
  };
}

/** The org's live server agents joined with their resource rows. */
export async function liveServers(store, orgId) {
  const resources = (await store.list('monitoredResource', { orgId, type: 'server' })).filter(
    (r) => !r.deletedAt && r.agentId,
  );
  const agents = new Map((await store.list('agent', { orgId })).map((a) => [a.id, a]));
  return resources.filter((r) => agents.has(r.agentId)).map((r) => ({ resource: r, agent: agents.get(r.agentId) }));
}

export async function requireServer(store, orgId, id) {
  const agent = await store.find('agent', { id, orgId });
  const resource =
    agent && (await store.find('monitoredResource', { agentId: agent.id, type: 'server' }));
  assert(agent && resource && !resource.deletedAt, 404, 'Server not found.');
  return { agent, resource };
}

export async function listServers(store, orgId) {
  const configs = await store.list('agentConfig', { orgId });
  const byId = new Map(configs.map((c) => [c.id, c]));
  const fallback = configs.find((c) => c.isDefault);
  const now = Date.now();
  return (await liveServers(store, orgId))
    .map(({ agent, resource }) =>
      serverSummary(agent, resource, (byId.get(agent.configId) || fallback)?.settings, now),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

const configView = async (store, agent) => {
  const config = await configForAgent(store, agent);
  const users = await store.list('agent', { orgId: agent.orgId, configId: config.id });
  const shared = config.isDefault || users.filter((u) => u.id !== agent.id).length > 0;
  return {
    id: config.id,
    name: config.name,
    version: config.version,
    isDefault: config.isDefault,
    shared,
    settings: config.settings,
  };
};

export async function serverDetail(store, agent, resource) {
  const config = await configView(store, agent);
  const latest = await store.client.serverMetric.findFirst({
    where: { agentId: agent.id },
    orderBy: { time: 'desc' },
  });
  const details = latest?.details || {};
  return {
    ...serverSummary(agent, resource, config.settings),
    latest: latest && {
      time: latest.time,
      cpu: latest.cpuPercent,
      memory: latest.memPercent,
      swap: latest.swapPercent,
      disk: latest.diskPercent,
      load: [latest.load1, latest.load5, latest.load15],
      netRxBps: latest.netRxBps,
      netTxBps: latest.netTxBps,
      diskReadBps: latest.diskReadBps,
      diskWriteBps: latest.diskWriteBps,
      uptimeSeconds: latest.uptimeSeconds,
    },
    disks: details.mounts || [],
    interfaces: details.interfaces || [],
    processes: details.processes || [],
    config,
    createdAt: agent.createdAt,
  };
}

/** Change the display name and/or the server's own setup profile. */
export async function updateServer(store, agent, resource, input) {
  if (input.name !== undefined) await store.update('monitoredResource', resource.id, { name: input.name });
  if (input.config !== undefined) {
    const settings = agentSettingsSchema.parse(input.config);
    const current = await configForAgent(store, agent);
    const sharing = await store.list('agent', { orgId: agent.orgId, configId: current.id });
    const dedicated = !current.isDefault && sharing.every((a) => a.id === agent.id);
    if (dedicated) {
      // Agents compare versions, so every change bumps it.
      await store.update('agentConfig', current.id, { settings, version: current.version + 1 });
    } else {
      // Never edit a profile other servers use: give this server its own copy.
      const own = await store.create('agentConfig', {
        id: newConfigId(),
        orgId: agent.orgId,
        name: input.name ?? resource.name,
        isDefault: false,
        settings,
      });
      await store.update('agent', agent.id, { configId: own.id });
    }
  }
}

/** Chart data for one server. Raw samples for 1h; 5-minute and 1-hour continuous aggregates beyond. */
export async function serverMetrics(store, agent, rangeKey) {
  const range = RANGES[rangeKey];
  const { plan } = await entitlements(store, agent.orgId);
  const to = new Date();
  const wanted = new Date(to.getTime() - range.ms);
  const floor = retentionCutoff(plan, to.getTime());
  const clamped = floor > wanted;
  const from = clamped ? floor : wanted;
  const db = store.client;
  let rows;
  if (range.source === 'raw') {
    rows = await db.$queryRaw`
      SELECT "time" AS t,
        cpu_percent AS cpu, cpu_percent AS "cpuMax", mem_percent AS memory, mem_percent AS "memoryMax",
        swap_percent AS swap, load1, load5, load15, disk_percent AS disk,
        net_rx_bps AS "netRxBps", net_tx_bps AS "netTxBps",
        disk_read_bps AS "diskReadBps", disk_write_bps AS "diskWriteBps"
      FROM server_metrics
      WHERE agent_id = ${agent.id} AND "time" >= ${from} AND "time" <= ${to}
      ORDER BY "time"`;
  } else {
    // The view names differ only in bucket size, and a table name cannot be a bound parameter.
    const view = range.source === '5m' ? 'server_metrics_5m' : 'server_metrics_1h';
    rows = await db.$queryRawUnsafe(
      `SELECT bucket AS t,
        cpu_avg AS cpu, cpu_max AS "cpuMax", mem_avg AS memory, mem_max AS "memoryMax",
        swap_avg AS swap, load1_avg AS load1, NULL::float8 AS load5, NULL::float8 AS load15,
        disk_avg AS disk, net_rx_avg AS "netRxBps", net_tx_avg AS "netTxBps",
        disk_read_avg AS "diskReadBps", disk_write_avg AS "diskWriteBps"
      FROM ${view}
      WHERE agent_id = $1 AND bucket >= $2 AND bucket <= $3
      ORDER BY bucket`,
      agent.id,
      from,
      to,
    );
  }
  return {
    range: rangeKey,
    source: range.source,
    bucketSeconds: range.bucketSeconds,
    clamped,
    from,
    to,
    points: rows.map((r) => ({
      t: r.t,
      cpu: num(r.cpu),
      cpuMax: num(r.cpuMax),
      memory: num(r.memory),
      memoryMax: num(r.memoryMax),
      swap: num(r.swap),
      load1: num(r.load1),
      load5: num(r.load5),
      load15: num(r.load15),
      disk: num(r.disk),
      netRxBps: num(r.netRxBps),
      netTxBps: num(r.netTxBps),
      diskReadBps: num(r.diskReadBps),
      diskWriteBps: num(r.diskWriteBps),
    })),
  };
}
