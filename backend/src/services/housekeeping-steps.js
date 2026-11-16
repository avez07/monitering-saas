import { entitlements } from './limits.js';
import { runDunning } from './billing.js';
import { getRedis } from '../lib/redis.js';

// The individual background steps. The `housekeeping` queue runs each on its own schedule
// (queues/housekeeping.js); `housekeeping(store)` runs them all in one pass (tests, manual runs).

export const OFFLINE_AFTER_MS = 180000;
/** Sorted set (score = last-seen ms, member = agent id) that the ingest workers keep up to date. */
export const LASTSEEN_KEY = 'lastseen'; // stored as yk:lastseen

async function setOffline(store, agentIds) {
  for (const id of agentIds) {
    await store.update('agent', id, { status: 'offline' });
    for (const r of await store.list('monitoredResource', { agentId: id }))
      await store.update('monitoredResource', r.id, { status: 'unhealthy' });
  }
}

/**
 * Mark agents that stopped reporting. Uses the `yk:lastseen` ZSET when ingest maintains one (one range
 * query, no table scan); otherwise falls back to the `lastSeen` column in Postgres.
 */
export async function markOfflineAgents(store, { now = Date.now() } = {}) {
  const cutoff = now - OFFLINE_AFTER_MS;
  const redis = getRedis();
  let candidates = null;
  try {
    if ((await redis.zcard(LASTSEEN_KEY)) > 0)
      candidates = await redis.zrangebyscore(LASTSEEN_KEY, '-inf', cutoff);
  } catch {
    candidates = null;
  }
  const where = { status: { notIn: ['revoked', 'offline'] }, lastSeen: { lt: new Date(cutoff) } };
  if (candidates) {
    if (!candidates.length) return 0;
    where.id = { in: candidates };
  }
  const stale = await store.client.agent.findMany({ where, select: { id: true } });
  await setOffline(store, stale.map((a) => a.id));
  return stale.length;
}

/** Old uptime checks and finished deliveries beyond each plan's retention. (R-17d replaces this.) */
export async function enforceRetention(store) {
  for (const org of await store.list('organization')) {
    let days = 7;
    try {
      days = (await entitlements(store, org.id)).plan.retentionDays;
    } catch {
      /* retain metadata after subscription expiry */
    }
    const createdAt = { lt: new Date(Date.now() - days * 86400000) };
    for (const table of ['uptimeCheck', 'notificationDelivery'])
      await store.removeMany(table, { orgId: org.id, createdAt });
  }
}

/** Expired sessions are useless; remove them in bulk. */
export async function purgeSessions(store) {
  await store.removeMany('session', {
    OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: new Date(Date.now() - 7 * 86400000) } }],
  });
}

/** Install steps from a machine that never registered, and old agent events, are only useful briefly. */
export async function purgeEvents(store) {
  await store.removeMany('agentEvent', {
    agentId: null,
    createdAt: { lt: new Date(Date.now() - 7 * 86400000) },
  });
  await store.removeMany('agentEvent', { createdAt: { lt: new Date(Date.now() - 30 * 86400000) } });
}

export const dunning = (store) =>
  runDunning(store).catch((error) => console.error('[billing] dunning:', error.message));

export const METRIC_RETENTION_TABLES = ['server_metrics', 'container_metrics'];

/**
 * Raw metric history is bounded by Timescale retention policies (chunk drop, see the
 * 20261117010000 migration), not by a DELETE. Per-plan limits are applied when reading. This step only
 * verifies the policies still exist and logs loudly if not (e.g. a restore without Timescale jobs).
 * Returns the tables whose retention policy is missing.
 */
export async function trimMetrics(store) {
  let rows;
  try {
    rows = await store.client.$queryRaw`
      SELECT hypertable_name FROM timescaledb_information.jobs
      WHERE proc_name = 'policy_retention' AND hypertable_schema = 'public'`;
  } catch (error) {
    console.error('[housekeeping] cannot verify retention policies:', error.message);
    return [];
  }
  const have = new Set(rows.map((r) => r.hypertable_name));
  const missing = METRIC_RETENTION_TABLES.filter((t) => !have.has(t));
  if (missing.length) console.error(`[housekeeping] MISSING retention policy on: ${missing.join(', ')}`);
  return missing;
}

/** Every step once, in order. */
export async function housekeeping(store) {
  await markOfflineAgents(store);
  await enforceRetention(store);
  await purgeSessions(store);
  await purgeEvents(store);
  await dunning(store);
  await trimMetrics(store);
}
