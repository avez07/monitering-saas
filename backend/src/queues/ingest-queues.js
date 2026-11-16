import { Queue } from 'bullmq';
import { createBullConnection } from '../lib/redis.js';

/** BullMQ keys for the ingest pipeline live under this prefix (separate from the `yk:` application keys). */
export const BULL_PREFIX = 'yk:bull';

export const INGEST_QUEUE = 'ingest';
export const SIDE_EFFECTS_QUEUE = 'side-effects';
export const LASTSEEN_QUEUE = 'lastseen';

const JOB_DEFAULTS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: true,
  removeOnFail: { count: 1000 },
};

const queues = new Map();
/** One shared Queue (producer) per name and process; each owns a Redis connection. */
export function getQueue(name) {
  let queue = queues.get(name);
  if (!queue) {
    const connection = createBullConnection();
    queue = new Queue(name, {
      connection,
      prefix: BULL_PREFIX,
      defaultJobOptions: JOB_DEFAULTS,
    });
    queue.on('error', () => {}); // connection errors are retried by ioredis
    queue.sharedConnection = connection;
    queues.set(name, queue);
  }
  return queue;
}
export const ingestQueue = () => getQueue(INGEST_QUEUE);
export const sideEffectsQueue = () => getQueue(SIDE_EFFECTS_QUEUE);

export async function closeIngestQueues() {
  const open = [...queues.values()];
  queues.clear();
  await Promise.all(
    open.map(async (q) => {
      await q.close().catch(() => {});
      await q.sharedConnection.quit().catch(() => q.sharedConnection.disconnect());
    }),
  );
}

// ---------------------------------------------------------------------------------------- backpressure

const limits = {
  maxWaiting: Number(process.env.INGEST_MAX_WAITING) || 50000,
  maxLagMs: (Number(process.env.INGEST_MAX_LAG_SECONDS) || 60) * 1000,
};
const CHECK_EVERY_MS = 1000;
let cached = { at: 0, overloaded: false };

/** Override the thresholds (tests, tuning). Also forgets the cached verdict. */
export function setBackpressure({ maxWaiting, maxLagMs } = {}) {
  if (maxWaiting !== undefined) limits.maxWaiting = maxWaiting;
  if (maxLagMs !== undefined) limits.maxLagMs = maxLagMs;
  cached = { at: 0, overloaded: false };
}

/** Queue depth and the age of the oldest waiting job (what the 503 decision and /metrics look at). */
export async function ingestPressure(now = Date.now()) {
  const queue = ingestQueue();
  const [waiting, oldest] = await Promise.all([queue.getWaitingCount(), queue.getWaiting(0, 0)]);
  const lagMs = oldest[0] ? Math.max(0, now - oldest[0].timestamp) : 0;
  return { waiting, lagMs };
}

/**
 * True when the ingest workers are too far behind: more than `maxWaiting` jobs waiting or the oldest
 * waiting job older than `maxLagMs`. The verdict is cached for a second so the hot path stays cheap.
 * If Redis cannot answer, we do not claim overload (the enqueue itself will fail and surface as 5xx).
 */
export async function ingestOverloaded(now = Date.now()) {
  if (now - cached.at < CHECK_EVERY_MS) return cached.overloaded;
  cached = { at: now, overloaded: cached.overloaded }; // concurrent requests reuse the old verdict
  try {
    const { waiting, lagMs } = await ingestPressure(now);
    cached = { at: now, overloaded: waiting > limits.maxWaiting || lagMs > limits.maxLagMs };
  } catch {
    cached = { at: now, overloaded: false };
  }
  return cached.overloaded;
}
