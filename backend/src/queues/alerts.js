import { config } from '../config.js';
import { getQueue, startWorker } from './factory.js';
import { evaluateAlerts } from '../services/alerting.js';
import { suspendedOrgIds } from '../services/platform-suspension.js';

export const ALERTS_QUEUE = 'alerts';
export const ALERTS_CONCURRENCY = 10;
export const ALERT_INTERVAL_MS = () => config.WORKER_INTERVAL_MS; // 30 s by default
const SCHEDULER_ID = 'alerts-tick';

export const alertsQueue = () => getQueue(ALERTS_QUEUE);

/** Idempotent: every alerts worker calls it on start; BullMQ keeps exactly one scheduler. */
export function startAlertsScheduler(every = ALERT_INTERVAL_MS()) {
  return alertsQueue().upsertJobScheduler(
    SCHEDULER_ID,
    { every },
    { name: 'tick', opts: { removeOnComplete: true, removeOnFail: 50 } },
  );
}

/** Organizations that have an enabled rule or an open incident (the only ones worth evaluating). */
export async function orgsToEvaluate(store) {
  const [rules, open] = await Promise.all([
    store.client.alertRule.findMany({
      where: { enabled: true, deletedAt: null },
      select: { orgId: true },
      distinct: ['orgId'],
    }),
    store.client.alertIncident.findMany({
      where: { state: { in: ['pending', 'firing', 'acknowledged'] } },
      select: { orgId: true },
      distinct: ['orgId'],
    }),
  ]);
  const suspended = await suspendedOrgIds(store); // platform-suspended orgs are not evaluated
  return [...new Set([...rules.map((r) => r.orgId), ...open.map((i) => i.orgId)])].filter(
    (orgId) => !suspended.has(orgId),
  );
}

/** Queue one evaluation per organization. The id carries the time bucket, so a tick is never doubled. */
export async function fanOut(store, { every = ALERT_INTERVAL_MS(), now = Date.now() } = {}) {
  const bucket = Math.floor(now / every);
  const orgs = await orgsToEvaluate(store);
  if (orgs.length)
    await alertsQueue().addBulk(
      orgs.map((orgId) => ({
        name: 'evaluate',
        data: { orgId },
        opts: { jobId: `eval:${orgId}:${bucket}`, removeOnComplete: true, removeOnFail: 50 },
      })),
    );
  return orgs.length;
}

/** `tick` fans out to one `evaluate` job per org; `evaluate` runs the (unchanged) rule state machine. */
export async function processAlertJob(store, job, { now } = {}) {
  if (job.name === 'tick') return fanOut(store);
  await evaluateAlerts(store, job.data.orgId, now ? { now } : undefined);
  return true;
}

export function startAlertsWorker(store, { concurrency = ALERTS_CONCURRENCY } = {}) {
  return startWorker(ALERTS_QUEUE, (job) => processAlertJob(store, job), { concurrency });
}
