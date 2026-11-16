import { getQueue, startWorker } from './factory.js';
import { refreshDomainExpiry } from '../services/rdap.js';
import {
  markOfflineAgents,
  enforceRetention,
  purgeSessions,
  purgeEvents,
  dunning,
  trimMetrics,
} from '../services/housekeeping-steps.js';
import { reconcileMonitors } from './checks.js';
import { enqueueDelivery } from './notify.js';

export const HOUSEKEEPING_QUEUE = 'housekeeping';
export const housekeepingQueue = () => getQueue(HOUSEKEEPING_QUEUE);

/** A delivery still pending this long after it was due has probably lost its job (Redis hiccup). */
const STUCK_MS = 120000;
export async function sweepStuckDeliveries(store, { now = Date.now() } = {}) {
  const stuck = await store.client.notificationDelivery.findMany({
    where: { status: 'pending', nextAttemptAt: { lt: new Date(now - STUCK_MS) } },
    take: 500,
  });
  for (const delivery of stuck) await enqueueDelivery(delivery).catch(() => {});
  return stuck.length;
}

/**
 * name -> { every | pattern, run(store) }. A scheduler per entry guarantees it runs once per period no
 * matter how many housekeeping workers exist. `retention` and `trim-metrics` are the hooks R-17d replaces
 * (use `setHousekeepingHandler`).
 */
export const JOBS = {
  'agents-offline': { every: 60000, run: (store) => markOfflineAgents(store) },
  'notify-sweep': { every: 60000, run: (store) => sweepStuckDeliveries(store) },
  'reconcile-checks': { every: 300000, run: (store) => reconcileMonitors(store) },
  'domain-expiry': { every: 300000, run: (store) => refreshDomainExpiry(store) },
  'sessions-purge': { pattern: '*/15 * * * *', run: (store) => purgeSessions(store) },
  'events-purge': { pattern: '5 * * * *', run: (store) => purgeEvents(store) },
  retention: { pattern: '15 * * * *', run: (store) => enforceRetention(store) },
  'trim-metrics': { pattern: '25 * * * *', run: (store) => trimMetrics(store) },
  dunning: { pattern: '0 * * * *', run: (store) => dunning(store) },
};
/** Replace (or add) a housekeeping step's handler; its schedule is unchanged unless you pass one. */
export function setHousekeepingHandler(name, run, schedule) {
  JOBS[name] = { ...JOBS[name], ...schedule, run };
}

export async function startHousekeepingSchedulers() {
  const queue = housekeepingQueue();
  for (const [name, job] of Object.entries(JOBS))
    await queue.upsertJobScheduler(
      name,
      job.pattern ? { pattern: job.pattern } : { every: job.every },
      { name, opts: { removeOnComplete: true, removeOnFail: 50 } },
    );
}

export function processHousekeeping(store, job) {
  const step = JOBS[job.name];
  if (!step) throw new Error(`Unknown housekeeping job ${job.name}`);
  return step.run(store);
}

export function startHousekeepingWorker(store, { concurrency = 2 } = {}) {
  return startWorker(HOUSEKEEPING_QUEUE, (job) => processHousekeeping(store, job), { concurrency });
}
