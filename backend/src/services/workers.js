import { runDueChecks } from './checks.js';
import { evaluateAlerts } from './alerting.js';
import { deliverNotifications, closeSmtp } from './contacts.js';
import { housekeeping } from './housekeeping-steps.js';
import { closeQueues, stopWorker, queueStatus, queueConnected } from '../queues/factory.js';
import { startChecksWorker, reconcileMonitors, CHECKS_QUEUE } from '../queues/checks.js';
import { startAlertsWorker, startAlertsScheduler, ALERTS_QUEUE } from '../queues/alerts.js';
import { startNotifyWorker, NOTIFY_QUEUE } from '../queues/notify.js';
import {
  startHousekeepingWorker,
  startHousekeepingSchedulers,
  HOUSEKEEPING_QUEUE,
} from '../queues/housekeeping.js';
import './services.js'; // registers the "Service stopped" alert source for the worker

// Alerting, website checks and delivery live in their own services; they are re-exported here so older
// callers (and tests) have one place to import background steps from. The `*Once` sweeps run a whole
// pass inline with an injectable clock; production work goes through the BullMQ queues in ../queues.
export { evaluateAlerts, deliverNotifications, housekeeping };
export const runChecks = (store, options) => runDueChecks(store, options);

/**
 * Worker roles. Each role has `start(store, options)` returning a handle `{ workers, stop }` and the list of
 * queue names it serves (for /healthz).
 *
 * WIRING HOOK (ingest / side-effects): call `registerRole('ingest', { queues: ['ingest'], start })` and
 * `registerRole('side-effects', ...)` from the module that owns them and import that module in
 * src/worker.js (or add the entries to ROLES below). `--role=all` starts every registered role.
 */
export const ROLES = {
  checks: {
    queues: [CHECKS_QUEUE],
    async start(store, options = {}) {
      const worker = startChecksWorker(store, options.checks);
      await worker.waitUntilReady();
      await reconcileMonitors(store); // schedulers for every enabled monitor, even after a Redis flush
      return { workers: [worker] };
    },
  },
  alerts: {
    queues: [ALERTS_QUEUE],
    async start(store, options = {}) {
      const worker = startAlertsWorker(store, options.alerts);
      await worker.waitUntilReady();
      await startAlertsScheduler(options.alertsEveryMs);
      return { workers: [worker] };
    },
  },
  notify: {
    queues: [NOTIFY_QUEUE],
    async start(store, options = {}) {
      const worker = startNotifyWorker(store, options.notify);
      await worker.waitUntilReady();
      return { workers: [worker], onStop: async () => closeSmtp() };
    },
  },
  housekeeping: {
    queues: [HOUSEKEEPING_QUEUE],
    async start(store, options = {}) {
      const worker = startHousekeepingWorker(store, options.housekeeping);
      await worker.waitUntilReady();
      await startHousekeepingSchedulers();
      return { workers: [worker] };
    },
  },
  // <-- ingest / side-effects roles are registered here by the ingest pipeline (see hook above).
};
export function registerRole(name, role) {
  ROLES[name] = role;
}
export const roleNames = () => Object.keys(ROLES);

/**
 * Start the given roles ('all' or undefined = every registered role). Returns
 * `{ roles, stop(), health() }`. `stop()` lets active jobs finish, then closes workers, queues, SMTP and
 * the Redis connections this process opened. Starting twice with the same store is fine (schedulers are
 * idempotent), which is how tests run "three workers".
 */
export async function startRoles(store, roles = 'all', options = {}) {
  const wanted = roles === 'all' || !roles ? roleNames() : [].concat(roles);
  for (const name of wanted) if (!ROLES[name]) throw new Error(`Unknown worker role "${name}".`);
  const handles = [];
  for (const name of wanted) handles.push({ name, ...(await ROLES[name].start(store, options)) });
  const queues = [...new Set(wanted.flatMap((name) => ROLES[name].queues ?? []))];
  let stopped = false;
  return {
    roles: wanted,
    handles,
    async stop({ closeConnections = true } = {}) {
      if (stopped) return;
      stopped = true;
      for (const handle of handles) {
        await Promise.all((handle.workers ?? []).map((w) => stopWorker(w)));
        await handle.onStop?.();
      }
      if (closeConnections) await closeQueues();
    },
    /** Status for /healthz: queue connection, job counts and the last time each queue finished a job. */
    async health() {
      const connected = await queueConnected();
      return { ok: connected, roles: wanted, redis: connected, queues: connected ? await queueStatus(queues) : {} };
    },
  };
}
