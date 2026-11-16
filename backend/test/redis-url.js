import { config } from '../src/config.js';
import { configureRedis } from '../src/lib/redis.js';

/** Integration tests always use their own Redis DB index (flushed on every setup), never the dev one. */
export function testRedisUrl() {
  if (process.env.TEST_REDIS_URL) return process.env.TEST_REDIS_URL;
  const url = new URL(config.REDIS_URL);
  url.pathname = '/1';
  return url.toString();
}

const db = (url) => new URL(url).pathname || '/0';
const target = testRedisUrl();
// FLUSHDB below is destructive: refuse to run against the development Redis database.
if (db(target) === db(config.REDIS_URL) && new URL(target).host === new URL(config.REDIS_URL).host)
  throw new Error('TEST_REDIS_URL must use a different Redis DB index than REDIS_URL.');
// Everything in the process (limits, agent cache, RDAP/releases caches) now talks to the test DB.
configureRedis({ url: target });
