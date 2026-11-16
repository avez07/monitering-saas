import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setup, closeStore, register } from './helpers.js';
import { captureTransports, resetTransports, makeServer, feed } from './b2-helpers.js';
import { setTransports } from '../src/services/contacts.js';
import { getQueue, startWorker, drainQueue, runQueueOnce, stopWorker } from '../src/queues/factory.js';
import { syncMonitor, processCheck, reconcileMonitors, checksQueue, schedulerId } from '../src/queues/checks.js';
import { startNotifyWorker, setNotifyBackoff, processDelivery, notifyQueue } from '../src/queues/notify.js';
import { startAlertsScheduler, fanOut, alertsQueue, processAlertJob } from '../src/queues/alerts.js';
import {
  startHousekeepingSchedulers,
  housekeepingQueue,
  JOBS,
  sweepStuckDeliveries,
} from '../src/queues/housekeeping.js';
import { startRoles, roleNames } from '../src/services/workers.js';
import { startWorkerProcess, parseRole } from '../src/worker.js';
import { evaluateAlerts } from '../src/services/workers.js';

let store, app, sent;
beforeEach(async () => {
  ({ store, app } = await setup());
  sent = captureTransports();
  setNotifyBackoff(20);
});
afterEach(resetTransports);
after(closeStore);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (fn, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(50);
  }
};
const makeMonitor = async (owner, extra = {}) =>
  store.client.uptimeMonitor.create({
    data: {
      orgId: owner.orgId,
      projectId: owner.project.id,
      name: 'Queue site',
      type: 'http',
      target: 'https://example.com/',
      intervalSeconds: 60,
      failureThreshold: 2,
      status: 'pending',
      enabled: true,
      ...extra,
    },
  });
const ok = async () => ({ status: 200, body: 'ok', latencyMs: 7 });
const fail = async () => ({ status: 500, body: 'no', latencyMs: 7 });

test('a scheduler fires each job exactly once even with three workers', async () => {
  const owner = await register(app, 'Sched');
  const monitor = await makeMonitor(owner);
  let calls = 0;
  const seen = [];
  const request = async () => {
    calls++;
    return { status: 200, body: 'ok', latencyMs: 3 };
  };
  const workers = [1, 2, 3].map(() =>
    startWorker('checks', async (job) => {
      seen.push(job.id);
      return processCheck(store, job, { request });
    }, { concurrency: 5 }),
  );
  await Promise.all(workers.map((w) => w.waitUntilReady()));
  await checksQueue().upsertJobScheduler(
    schedulerId(monitor.id),
    { every: 300 },
    { name: 'check', data: { monitorId: monitor.id }, opts: { removeOnComplete: true } },
  );
  await waitFor(() => seen.length >= 3);
  await Promise.all(workers.map((w) => stopWorker(w)));
  assert.equal(new Set(seen).size, seen.length, 'no job was processed twice');
  assert.equal(calls, seen.length, 'one check per job');
  assert.equal(await store.client.uptimeCheck.count({ where: { monitorId: monitor.id } }), seen.length);
});

test('syncMonitor follows create, pause, resume and delete; reconcile heals a missed sync', async () => {
  const owner = await register(app, 'Sync');
  const monitor = await makeMonitor(owner, { intervalSeconds: 300 });
  const scheduler = async () => checksQueue().getJobScheduler(schedulerId(monitor.id));
  await syncMonitor(monitor, { immediate: true });
  assert.equal((await scheduler()).every, 300000);
  assert.equal((await checksQueue().getJobCounts('waiting', 'delayed')).waiting, 1, 'immediate first check');
  await syncMonitor({ ...monitor, intervalSeconds: 600 });
  assert.equal((await scheduler()).every, 600000, 'interval change is picked up');
  await syncMonitor({ ...monitor, enabled: false });
  assert.equal(await scheduler(), undefined, 'paused monitors are not scheduled');

  // The API saved the monitor but crashed before enqueuing: reconcile creates the scheduler.
  const report = await reconcileMonitors(store);
  assert.equal(report.upserted, 1);
  assert.equal((await scheduler()).every, 300000);
  // A stray scheduler for a deleted monitor is removed.
  await store.client.uptimeMonitor.delete({ where: { id: monitor.id } });
  assert.equal((await reconcileMonitors(store)).removed, 1);
  assert.equal(await scheduler(), undefined);
});

test('a check job runs the existing retry-before-down flow and queues the quick retry', async () => {
  const owner = await register(app, 'Retry');
  const monitor = await makeMonitor(owner);
  const job = { data: { monitorId: monitor.id } };
  assert.equal((await processCheck(store, job, { request: ok })).status, 'healthy');
  assert.equal((await processCheck(store, job, { request: fail })).status, 'healthy', 'one failure is not an outage');
  const delayed = await checksQueue().getDelayed();
  assert.equal(delayed.length, 1);
  assert.match(delayed[0].id, /^retry:/);
  assert.equal((await processCheck(store, job, { request: fail })).status, 'unhealthy');
  assert.equal((await store.find('uptimeMonitor', { id: monitor.id })).downSince !== null, true);
  // A paused or deleted monitor is skipped and unscheduled.
  await store.update('uptimeMonitor', monitor.id, { enabled: false });
  assert.deepEqual(await processCheck(store, job, { request: ok }), { skipped: true });
});

async function firingIncident(owner, name = 'queue-1') {
  const T = Date.now();
  const srv = await makeServer(store, owner, name, new Date(T));
  const res = await owner.client.post('/api/alerts/rules/from-template').send({ templateKey: 'cpu_very_high' });
  assert.equal(res.status, 201, res.text);
  await feed(store, srv, T - 5 * 60000, T, { cpuPercent: 95 });
  await evaluateAlerts(store, owner.orgId, { now: T });
  return (await store.list('notificationDelivery', { orgId: owner.orgId }))[0];
}

test('a notification job retries with backoff, then dead-letters and the outbox shows failed', async () => {
  const owner = await register(app, 'Notify');
  let attempts = 0;
  setTransports({
    email: async () => {
      attempts++;
      throw new Error('smtp down');
    },
  });
  const delivery = await firingIncident(owner);
  assert.equal(delivery.status, 'pending');
  const queued = await notifyQueue().getJob(delivery.id);
  assert.ok(queued, 'enqueueNotifications queued a job with jobId = deliveryId');

  const worker = startNotifyWorker(store, { concurrency: 2 });
  await worker.waitUntilReady();
  await waitFor(async () => (await store.find('notificationDelivery', { id: delivery.id })).status === 'failed');
  await drainQueue('notify', { delayed: true });
  await stopWorker(worker);
  const row = await store.find('notificationDelivery', { id: delivery.id });
  assert.equal(row.attempts, 5);
  assert.equal(attempts, 5);
  assert.match(row.error, /smtp down/);
  const failed = await notifyQueue().getFailed();
  assert.equal(failed.length, 1, 'the job is kept in the failed set (dead letter)');
  assert.equal(failed[0].id, delivery.id);
});

test('a notification that fails once is retried and then delivered', async () => {
  const owner = await register(app, 'Flaky');
  let attempts = 0;
  setTransports({
    email: async (message) => {
      attempts++;
      if (attempts === 1) throw new Error('timeout');
      sent.email.push(message);
      return 'delivered';
    },
  });
  const delivery = await firingIncident(owner);
  await runQueueOnce('notify', (job) => processDelivery(store, job), { delayed: true });
  const row = await store.find('notificationDelivery', { id: delivery.id });
  assert.equal(row.status, 'delivered');
  assert.equal(row.attempts, 2);
  assert.equal(sent.email.length, 1);
});

test('alerts tick fans out one job per org, once per time bucket; sweeps requeue stuck deliveries', async () => {
  const a = await register(app, 'OrgA');
  const b = await register(app, 'OrgB');
  const now = Date.now();
  assert.equal(await fanOut(store, { every: 30000, now }), 2);
  await fanOut(store, { every: 30000, now }); // same bucket: deduplicated
  const counts = await alertsQueue().getJobCounts('waiting');
  assert.equal(counts.waiting, 2);
  const jobs = await alertsQueue().getWaiting();
  assert.deepEqual(jobs.map((j) => j.data.orgId).sort(), [a.orgId, b.orgId].sort());
  await runQueueOnce('alerts', (job) => processAlertJob(store, job));
  await startAlertsScheduler(60000);
  await startAlertsScheduler(60000); // idempotent
  assert.equal((await alertsQueue().getJobSchedulers()).length, 1);

  // A delivery whose job was lost is queued again by the sweep.
  const delivery = await firingIncident(a, 'stuck-1');
  await notifyQueue().remove(delivery.id);
  assert.equal(await sweepStuckDeliveries(store, { now: Date.now() + 10 * 60000 }), 1);
  assert.ok(await notifyQueue().getJob(delivery.id));
});

test('housekeeping schedulers are installed once; roles start together and report health', async () => {
  await startHousekeepingSchedulers();
  await startHousekeepingSchedulers();
  const names = (await housekeepingQueue().getJobSchedulers()).map((s) => s.key).sort();
  assert.deepEqual(names, Object.keys(JOBS).sort());

  assert.deepEqual(roleNames().sort(), ['alerts', 'checks', 'housekeeping', 'ingest', 'notify']);
  assert.equal(parseRole(['--role=notify'], {}), 'notify');
  assert.equal(parseRole([], {}), 'all');
  await assert.rejects(() => startRoles(store, 'nope'), /Unknown worker role/);
});

test('startRoles("all") serves /healthz and stops gracefully', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const worker = await startWorkerProcess({ role: 'all', store, healthPort: port });
  const body = await new Promise((resolve, reject) =>
    http.get(`http://127.0.0.1:${port}/healthz`, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
    }).on('error', reject),
  );
  assert.equal(body.status, 200);
  assert.equal(body.json.redis, true);
  assert.deepEqual(Object.keys(body.json.queues).sort(), ['alerts', 'checks', 'housekeeping', 'ingest', 'lastseen', 'notify', 'side-effects']);
  await worker.stop();
  await getQueue('checks'); // queues can be re-created after a stop
});
