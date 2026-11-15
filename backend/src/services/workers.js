import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { entitlements } from './limits.js';
import { trimRawMetricsByPlan } from './metrics.js';
import { runDueChecks } from './checks.js';
import { refreshDomainExpiry } from './rdap.js';
import { evaluateAlerts } from './alerting.js';
import { deliverNotifications } from './contacts.js';
import { trimContainerMetricsByPlan } from './containers.js';
import { runDunning } from './billing.js';
import './services.js'; // registers the "Service stopped" alert source for the worker

// Alerting, website checks and delivery live in their own services; they are re-exported here so the
// worker (and older callers) have one place to import background steps from.
export { evaluateAlerts, deliverNotifications };
export const runChecks = (store, options) => runDueChecks(store, options);

export async function housekeeping(store) {
  for (const agent of await store.list('agent')) {
    if (agent.status === 'revoked' || agent.status === 'offline') continue;
    if (Date.now() - new Date(agent.lastSeen) > 180000) {
      await store.update('agent', agent.id, { status: 'offline' });
      for (const r of await store.list('monitoredResource', { agentId: agent.id }))
        await store.update('monitoredResource', r.id, { status: 'unhealthy' });
    }
  }
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
  // Expired sessions are useless; remove them in bulk.
  const now = new Date();
  await store.removeMany('session', {
    OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: new Date(Date.now() - 7 * 86400000) } }],
  });
  // Install steps from a machine that never registered, and old agent events, are only useful briefly.
  await store.removeMany('agentEvent', {
    agentId: null,
    createdAt: { lt: new Date(Date.now() - 7 * 86400000) },
  });
  await store.removeMany('agentEvent', { createdAt: { lt: new Date(Date.now() - 30 * 86400000) } });
  // Per-plan raw history limits only need checking occasionally.
  if (Date.now() - lastMetricTrim > 3600000) {
    lastMetricTrim = Date.now();
    await runDunning(store).catch((error) => console.error('[billing] dunning:', error.message));
    await trimRawMetricsByPlan(store);
    await trimContainerMetricsByPlan(store);
  }
}
let lastMetricTrim = 0;

export const LEASE_ID = 'main-worker';
export const LEASE_MS = 90000;
/**
 * Try to become the single active worker. The lease lives in Postgres, so two worker processes can
 * never run at once, and a crashed worker is replaced as soon as its lease expires.
 */
export async function acquireLease(store, holder, ttlMs = LEASE_MS) {
  const expiresAt = new Date(Date.now() + ttlMs);
  const row = await store.find('workerLease', { id: LEASE_ID });
  if (!row) {
    try {
      await store.create('workerLease', { id: LEASE_ID, holder, expiresAt });
      return true;
    } catch (error) {
      if (error.code === 'P2002') return false; // another worker created it first
      throw error;
    }
  }
  if (row.holder !== holder && row.expiresAt > new Date()) return false;
  // Atomically take over only if nobody changed the lease since we read it.
  return store.claim(
    'workerLease',
    LEASE_ID,
    { holder: row.holder, expiresAt: row.expiresAt },
    { holder, expiresAt },
  );
}
export async function releaseLease(store, holder) {
  await store.client?.workerLease.updateMany({
    where: { id: LEASE_ID, holder },
    data: { expiresAt: new Date(0) },
  });
}

/** One pass of background work. Returns false when another worker holds the lease. */
export async function runWorkerTick(store, holder) {
  if (!(await acquireLease(store, holder))) return false;
  for (const step of [runChecks, refreshDomainExpiry, evaluateAlerts, deliverNotifications, housekeeping]) {
    await step(store);
    // A long step must not let the lease expire underneath us.
    if (!(await acquireLease(store, holder))) return false;
  }
  return true;
}
export function startWorkers(store) {
  const holder = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runWorkerTick(store, holder);
    } catch (error) {
      console.error('Worker:', error.message);
    } finally {
      running = false;
    }
  };
  tick();
  const timer = setInterval(tick, config.WORKER_INTERVAL_MS);
  return async () => {
    clearInterval(timer);
    await releaseLease(store, holder).catch(() => {});
  };
}
