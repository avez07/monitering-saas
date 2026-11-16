import { createHash } from 'node:crypto';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { UnrecoverableError } from 'bullmq';
import { getQueue, startWorker } from './factory.js';
import { getRedis } from '../lib/redis.js';
import { attemptDelivery, MAX_DELIVERY_ATTEMPTS } from '../services/contacts.js';

export const NOTIFY_QUEUE = 'notify';
export const NOTIFY_CONCURRENCY = 20;

let backoffMs = 30000;
/** Base delay of the exponential backoff (30 s, 60 s, 120 s, ...). Tests shorten it. */
export const setNotifyBackoff = (ms) => {
  backoffMs = ms;
};

export const notifyQueue = () => getQueue(NOTIFY_QUEUE);

/** Queue one delivery. The job id is the delivery id, so queuing it twice is a no-op. */
export function enqueueDelivery(delivery, { delayMs = 0 } = {}) {
  return notifyQueue().add(
    'deliver',
    { deliveryId: delivery.id },
    {
      jobId: delivery.id,
      attempts: MAX_DELIVERY_ATTEMPTS,
      backoff: { type: 'exponential', delay: backoffMs },
      removeOnComplete: true,
      removeOnFail: 1000, // the dead-letter list; the outbox row carries status 'failed' too
      ...(delayMs ? { delay: delayMs } : {}),
    },
  );
}

// ---- Per-provider rate limits ----------------------------------------------------------------------

const digest = (value) => createHash('sha1').update(value).digest('hex').slice(0, 16);
const LIMITS = {
  // Telegram: about 30 messages/s per bot; Slack: 1/s per webhook; Discord: a few per second per webhook.
  telegram: { points: 25, duration: 1, key: () => 'telegram' },
  slack: { points: 1, duration: 1, key: (c) => `slack:${digest(c.address)}` },
  discord: { points: 2, duration: 1, key: (c) => `discord:${digest(c.address)}` },
};
const limiters = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until the channel's provider allows another message (shared by every worker through Redis). */
export async function throttle(channel) {
  const spec = LIMITS[channel?.type];
  if (!spec) return;
  let limiter = limiters.get(channel.type);
  if (!limiter)
    limiters.set(
      channel.type,
      (limiter = new RateLimiterRedis({
        storeClient: getRedis(),
        keyPrefix: `rl:notify:${channel.type}`,
        points: spec.points,
        duration: spec.duration,
      })),
    );
  for (let tries = 0; tries < 20; tries++) {
    try {
      await limiter.consume(spec.key(channel));
      return;
    } catch (rejected) {
      if (rejected instanceof Error) throw rejected; // a Redis problem: let the job retry
      await sleep(Math.max(20, rejected.msBeforeNext ?? 100));
    }
  }
}
export const resetThrottle = () => limiters.clear();

// ---- Processing -------------------------------------------------------------------------------------

/**
 * One job = one delivery through the existing transports. A failure records the attempt on the outbox
 * row and throws, so BullMQ retries with exponential backoff; on the fifth failure the row becomes
 * 'failed' (the dead letter, shown in the UI) and the job lands in BullMQ's failed set.
 */
export async function processDelivery(store, job) {
  const delivery = await store.client.notificationDelivery.findUnique({
    where: { id: job.data.deliveryId },
    include: { channel: true },
  });
  if (!delivery || delivery.status !== 'pending') return { skipped: true };
  await throttle(delivery.channel);
  const outcome = await attemptDelivery(store, delivery);
  if (outcome.ok) return outcome;
  if (outcome.status === 'failed') throw new UnrecoverableError(outcome.error);
  throw new Error(outcome.error);
}

export function startNotifyWorker(store, { concurrency = NOTIFY_CONCURRENCY } = {}) {
  return startWorker(NOTIFY_QUEUE, (job) => processDelivery(store, job), { concurrency });
}
