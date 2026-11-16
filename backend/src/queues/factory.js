import { Queue, Worker } from 'bullmq';
import { createBullConnection, redisUrl } from '../lib/redis.js';

/** BullMQ adds this in front of every key it owns (`yk:bull:<queue>:...`). */
export const BULL_PREFIX = 'yk:bull';

// One connection and one Queue object per queue name per process (and per Redis URL, so tests that
// point the process at another database get fresh ones).
const connections = new Map(); // url -> ioredis
const queues = new Map(); // `${url}|${name}` -> Queue
const workers = new Set();
const lastProcessed = new Map(); // queue name -> { at, ok, failed }

/** The shared connection queues use for adding jobs. Workers get their own (BullMQ duplicates it). */
export function bullConnection(url = redisUrl()) {
  let connection = connections.get(url);
  if (!connection) {
    connection = createBullConnection(url);
    connections.set(url, connection);
  }
  return connection;
}

export function getQueue(name, options = {}) {
  const url = redisUrl();
  const key = `${url}|${name}`;
  let queue = queues.get(key);
  if (!queue) {
    queue = new Queue(name, { connection: bullConnection(url), prefix: BULL_PREFIX, ...options });
    queue.on('error', () => {}); // ioredis reconnects; an unhandled 'error' would crash the process
    queues.set(key, queue);
  }
  return queue;
}

/**
 * Start a worker. `processor(job)` throws to retry/fail. Completion times are tracked per queue for
 * /healthz. The returned worker is also closed by `closeQueues()`.
 */
export function startWorker(name, processor, { concurrency = 1, ...options } = {}) {
  const worker = new Worker(name, processor, {
    connection: bullConnection(), // BullMQ duplicates it for the blocking connection and closes the copy
    prefix: BULL_PREFIX,
    concurrency,
    ...options,
  });
  worker.on('error', () => {});
  const note = (ok) => () => {
    const state = lastProcessed.get(name) ?? { at: null, ok: 0, failed: 0 };
    state.at = new Date().toISOString();
    state[ok ? 'ok' : 'failed']++;
    lastProcessed.set(name, state);
  };
  worker.on('completed', note(true));
  worker.on('failed', note(false));
  workers.add(worker);
  return worker;
}

/** Finish active jobs, then stop one worker (graceful: it does not take new jobs meanwhile). */
export async function stopWorker(worker) {
  workers.delete(worker);
  await worker.close();
}

/** Job counts and the last time a job finished, per queue name (for /healthz). */
export async function queueStatus(names) {
  const out = {};
  for (const name of names) {
    const counts = await getQueue(name).getJobCounts('waiting', 'active', 'delayed', 'failed');
    out[name] = { ...counts, lastProcessed: lastProcessed.get(name) ?? null };
  }
  return out;
}

/** True when the queue connection answers. */
export async function queueConnected() {
  try {
    return (await bullConnection().ping()) === 'PONG';
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until a queue has nothing waiting or running (and, with `delayed`, nothing delayed). Tests use
 * it to drain deterministically instead of sleeping; `until` can add another condition.
 */
export async function drainQueue(name, { delayed = false, timeoutMs = 15000, settleMs = 60 } = {}) {
  const queue = getQueue(name);
  const deadline = Date.now() + timeoutMs;
  const kinds = ['waiting', 'active', 'prioritized', ...(delayed ? ['delayed'] : [])];
  let quiet = 0;
  while (Date.now() < deadline) {
    const counts = await queue.getJobCounts(...kinds);
    const busy = kinds.some((kind) => counts[kind] > 0);
    // Two quiet reads in a row, so a job that is just moving between states is not missed.
    quiet = busy ? 0 : quiet + 1;
    if (quiet >= 2) return true;
    await sleep(settleMs);
  }
  throw new Error(`Queue ${name} did not drain within ${timeoutMs} ms.`);
}

/**
 * Run a queue's processor over everything currently queued, with a short-lived worker, and resolve when
 * it is empty. This is the deterministic "run the queue once" for tests.
 */
export async function runQueueOnce(name, processor, options = {}) {
  const worker = startWorker(name, processor, { concurrency: options.concurrency ?? 5 });
  try {
    await worker.waitUntilReady();
    await drainQueue(name, options);
  } finally {
    await stopWorker(worker);
  }
}

/** Close every worker, queue and connection this process opened. */
export async function closeQueues() {
  const w = [...workers];
  workers.clear();
  await Promise.all(w.map((worker) => worker.close().catch(() => {})));
  const q = [...queues.values()];
  queues.clear();
  await Promise.all(q.map((queue) => queue.close().catch(() => {})));
  const c = [...connections.values()];
  connections.clear();
  await Promise.all(c.map((conn) => (conn.status === 'end' ? null : conn.quit().catch(() => conn.disconnect()))));
}
