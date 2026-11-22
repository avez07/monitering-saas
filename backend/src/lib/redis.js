import Redis from 'ioredis';
import { config } from '../config.js';

/** Every key we write starts with this, so the instance can be shared and keys are easy to spot. */
export const KEY_PREFIX = 'yk:';
/** Pub/sub channel names are not prefixed by ioredis, so they carry the prefix themselves. */
export const CHANNELS = { agentInvalidate: 'yk:agent:invalidate' };

let override = null;
/** Point every default connection at another URL (tests use a separate DB index). Call before first use. */
export function configureRedis({ url } = {}) {
  override = url || null;
}
export const redisUrl = () => override || config.REDIS_URL;

/**
 * A new connection. `blocking: true` is for BullMQ workers/subscribers: no per-request retry cap and
 * no offline queue surprises (BullMQ requires maxRetriesPerRequest: null). `prefix: false` skips the
 * key prefix (pub/sub connections, and BullMQ which adds its own prefix).
 */
export function createRedisConnection({ url = redisUrl(), blocking = false, prefix = true, name } = {}) {
  const client = new Redis(url, {
    keyPrefix: prefix ? KEY_PREFIX : undefined,
    maxRetriesPerRequest: blocking ? null : 3,
    enableReadyCheck: true,
    connectionName: name,
    lazyConnect: false,
  });
  // Without a listener ioredis would crash the process on connection errors; it reconnects by itself.
  // ioredis emits this on every retry (~every 50ms-2s), so an unreachable Redis would flood the log.
  // Log the first failure per connection, then at most once a minute with a repeat count.
  let lastLogged = 0;
  let suppressed = 0;
  client.on('error', (error) => {
    if (process.env.NODE_ENV === 'test') return;
    const now = Date.now();
    if (lastLogged && now - lastLogged < 60_000) {
      suppressed += 1;
      return;
    }
    // AggregateError (ECONNREFUSED on ::1 and 127.0.0.1) has an empty message, so fall back to the code.
    const reason = error.message || error.code || error.errors?.[0]?.message || String(error);
    const repeats = suppressed ? ` (+${suppressed} similar errors in the last minute)` : '';
    console.error(`redis(${name || 'client'}): ${reason} - is Redis running at ${url}?${repeats}`);
    lastLogged = now;
    suppressed = 0;
  });
  client.on('ready', () => {
    if (lastLogged && process.env.NODE_ENV !== 'test') console.log(`redis(${name || 'client'}): connected`);
    lastLogged = 0;
    suppressed = 0;
  });
  return client;
}

const shared = new Map(); // url -> client
/** The shared general-purpose client (prefix yk:). */
export function getRedis(url = redisUrl()) {
  let client = shared.get(url);
  if (!client) {
    client = createRedisConnection({ url, name: 'shared' });
    shared.set(url, client);
  }
  return client;
}
/** A dedicated subscriber connection (a subscribed connection cannot run other commands). */
export const createSubscriber = (url = redisUrl()) =>
  createRedisConnection({ url, blocking: true, prefix: false, name: 'subscriber' });
/** A connection for BullMQ queues/workers (it applies its own prefix). */
export const createBullConnection = (url = redisUrl()) =>
  createRedisConnection({ url, blocking: true, prefix: false, name: 'bullmq' });

/** Close the shared clients (graceful shutdown, end of tests). */
export async function closeRedis() {
  const clients = [...shared.values()];
  shared.clear();
  await Promise.all(
    clients.map((c) => (c.status === 'end' ? null : c.quit().catch(() => c.disconnect()))),
  );
}
