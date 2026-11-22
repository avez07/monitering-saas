import { createHash } from 'node:crypto';
import { getQueue, startWorker } from './factory.js';
import { checkMonitorNow, hostOf, Gate, RETRY_DELAY_SECONDS } from '../services/checks.js';
import { isOrgSuspended } from '../services/platform-suspension.js';

export const CHECKS_QUEUE = 'checks';
export const CHECK_CONCURRENCY = 50;
export const PER_HOST = 2;

export const checksQueue = () => getQueue(CHECKS_QUEUE);
export const schedulerId = (monitorId) => `monitor:${monitorId}`;

/** Spread monitors with the same interval across it, so a 5-minute interval is not one big burst. */
const offsetFor = (monitorId, everyMs) =>
  createHash('sha1').update(monitorId).digest().readUInt32BE(0) % everyMs;

const jobOptions = { removeOnComplete: true, removeOnFail: 100 };

/**
 * Make the queue match one monitor: a job scheduler repeating at its interval while it is enabled, none
 * while paused or deleted. Call after create, update, pause, resume and delete. `immediate` also queues
 * one check right now (new or edited monitors show a result without waiting a full interval).
 */
export async function syncMonitor(monitor, { immediate = false } = {}) {
  const queue = checksQueue();
  if (!monitor.enabled) {
    await queue.removeJobScheduler(schedulerId(monitor.id));
    return;
  }
  const every = monitor.intervalSeconds * 1000;
  await queue.upsertJobScheduler(
    schedulerId(monitor.id),
    { every, offset: offsetFor(monitor.id, every) },
    { name: 'check', data: { monitorId: monitor.id }, opts: jobOptions },
  );
  if (immediate) await checkNow(monitor.id);
}
export const removeMonitor = (monitorId) => checksQueue().removeJobScheduler(schedulerId(monitorId));
/** Queue one extra check (a unique id, so it never collides with scheduled or retry jobs). */
export const checkNow = (monitorId, { delayMs = 0, kind = 'now' } = {}) =>
  checksQueue().add('check', { monitorId }, {
    ...jobOptions,
    jobId: `${kind}:${monitorId}:${Date.now()}`,
    ...(delayMs ? { delay: delayMs } : {}),
  });

/** Safe variant for request handlers: queue trouble is logged, never fails the user's request. */
export async function trySyncMonitor(monitor, options) {
  try {
    await syncMonitor(monitor, options);
  } catch (error) {
    console.error('checks: could not schedule monitor', monitor.id, error.message);
  }
}
export async function tryRemoveMonitor(monitorId) {
  try {
    await removeMonitor(monitorId);
  } catch (error) {
    console.error('checks: could not unschedule monitor', monitorId, error.message);
  }
}

/**
 * Make every enabled monitor have a scheduler at its current interval, and remove schedulers whose
 * monitor is gone or paused. Runs when a checks worker starts and every few minutes (housekeeping), so
 * a missed sync (API crash between save and enqueue) heals itself.
 */
export async function reconcileMonitors(store) {
  const queue = checksQueue();
  const monitors = await store.client.uptimeMonitor.findMany({ where: { enabled: true } });
  const existing = new Map();
  for (let start = 0; ; start += 1000) {
    const page = await queue.getJobSchedulers(start, start + 999, true);
    for (const s of page) if (s.key?.startsWith('monitor:')) existing.set(s.key, s);
    if (page.length < 1000) break;
  }
  const wanted = new Set();
  let upserted = 0;
  for (const monitor of monitors) {
    const key = schedulerId(monitor.id);
    wanted.add(key);
    if (existing.get(key)?.every === monitor.intervalSeconds * 1000) continue;
    await syncMonitor(monitor);
    upserted++;
  }
  let removed = 0;
  for (const key of existing.keys())
    if (!wanted.has(key)) {
      await queue.removeJobScheduler(key);
      removed++;
    }
  return { monitors: monitors.length, upserted, removed };
}

// ---- Processing -------------------------------------------------------------------------------------

const gates = new Map(); // host -> Gate (at most PER_HOST simultaneous checks against one host per worker)
async function withHost(host, fn) {
  let gate = gates.get(host);
  if (!gate) gates.set(host, (gate = new Gate(PER_HOST)));
  await gate.acquire();
  try {
    return await fn();
  } finally {
    gate.release();
    if (gate.active === 0 && gate.waiting.length === 0) gates.delete(host);
  }
}

/**
 * One job = one check: the existing SSRF-guarded `runCheck`, then the retry-before-down state machine.
 * While a failure is below the monitor's threshold, an extra check is queued 30 s later.
 */
export async function processCheck(store, job, deps = {}) {
  const { monitorId } = job.data;
  const monitor = await store.find('uptimeMonitor', { id: monitorId });
  if (!monitor || !monitor.enabled) {
    await removeMonitor(monitorId); // a deleted or paused monitor stops being scheduled
    return { skipped: true };
  }
  // A suspended organization keeps its schedule (reactivating resumes it) but nothing is checked.
  if (await isOrgSuspended(store, monitor.orgId)) return { skipped: true, suspended: true };
  const { result, status } = await withHost(hostOf(monitor.target), () =>
    checkMonitorNow(store, monitor, deps),
  );
  if (!result.ok && status !== 'unhealthy' && monitor.intervalSeconds > RETRY_DELAY_SECONDS)
    await checkNow(monitorId, { delayMs: RETRY_DELAY_SECONDS * 1000, kind: 'retry' });
  return { ok: result.ok, status };
}

export function startChecksWorker(store, { concurrency = CHECK_CONCURRENCY, deps } = {}) {
  return startWorker(CHECKS_QUEUE, (job) => processCheck(store, job, deps), { concurrency });
}
