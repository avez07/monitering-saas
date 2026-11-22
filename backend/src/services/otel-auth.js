import { assert } from '../lib/errors.js';
import { digest, token } from '../lib/crypto.js';
import { getRedis } from '../lib/redis.js';
import { entitlements } from './limits.js';

export const TELEMETRY_KEY_PREFIX = 'yk_otel';
export const KEY_HEADER = 'x-yuktiops-key';
const CACHE_SECONDS = 60;
const TOUCH_SECONDS = 60;
const LASTSEEN_TTL = 90 * 86400;

/** A new telemetry key. The raw value is returned once; only its hash is stored. */
export async function createTelemetryKey(store, orgId, userId, name) {
  const raw = token(TELEMETRY_KEY_PREFIX);
  const row = await store.create('apiKey', {
    orgId,
    createdById: userId,
    kind: 'telemetry',
    name,
    prefix: raw.slice(0, 12),
    tokenHash: digest(raw),
  });
  return { raw, row };
}
export const listTelemetryKeys = (store, orgId) =>
  store.client.apiKey.findMany({ where: { orgId, kind: 'telemetry', revokedAt: null }, orderBy: { createdAt: 'asc' } });

const cacheKey = (hash) => `otel:key:${hash}`;
/** Make a revoked key stop working now on every API instance (the lookup is cached for a minute). */
export const forgetTelemetryKey = (hash) => getRedis().del(cacheKey(hash));

/** Per-key last-seen info in Redis (what "Waiting for your first trace..." polls). */
export async function markSeen(keyId, signal, now = Date.now()) {
  const redis = getRedis();
  const key = `otel:seen:${keyId}`;
  const multi = redis.multi().hset(key, { at: String(now), signal }).expire(key, LASTSEEN_TTL);
  if (signal === 'traces') multi.set(`otel:traceseen:${keyId}`, String(now), 'EX', LASTSEEN_TTL);
  await multi.exec();
}
export async function readSeen(keyId) {
  const redis = getRedis();
  // Last-seen info is a convenience: if Redis is unreachable the key list and key creation must still work.
  const [seen, trace] = await Promise.all([redis.hgetall(`otel:seen:${keyId}`), redis.get(`otel:traceseen:${keyId}`)]).catch((error) => {
    console.error('otel: could not read last-seen info:', error.message);
    return [{}, null];
  });
  return {
    lastSeenAt: seen.at ? new Date(Number(seen.at)).toISOString() : null,
    lastSignal: seen.signal ?? null,
    traceSeen: Boolean(trace),
  };
}

/**
 * Authenticate an OTLP request by `x-yuktiops-key`. Only telemetry keys work (install keys do not, and
 * telemetry keys do not work for /v1/register). Sets req.otel = { keyId, orgId, planId }. Wrong keys
 * from one address are throttled.
 */
export function telemetryKeyAuth(store, limits) {
  return async (req, res, next) => {
    try {
      await limits.assertUnder(`otel:badkey:${req.ip}`, 30, 600);
      const raw = req.headers[KEY_HEADER];
      const fail = async (message = 'The telemetry key is missing, wrong or has been revoked.') => {
        await limits.record(`otel:badkey:${req.ip}`, 600);
        assert(false, 401, message);
      };
      if (typeof raw !== 'string' || !raw.startsWith(`${TELEMETRY_KEY_PREFIX}_`) || raw.length > 200) await fail();
      const hash = digest(raw);
      const redis = getRedis();
      let ctx = null;
      const cached = await redis.get(cacheKey(hash));
      if (cached) ctx = JSON.parse(cached);
      if (!ctx) {
        const key = await store.find('apiKey', { tokenHash: hash });
        if (!key || key.kind !== 'telemetry' || key.revokedAt) await fail();
        const { plan } = await entitlements(store, key.orgId); // 402/403 when there is no active subscription
        ctx = { keyId: key.id, orgId: key.orgId, planId: plan.id };
        await redis.set(cacheKey(hash), JSON.stringify(ctx), 'EX', CACHE_SECONDS);
      }
      if (await redis.set(`otel:touch:${ctx.keyId}`, '1', 'EX', TOUCH_SECONDS, 'NX'))
        store.update('apiKey', ctx.keyId, { lastUsedAt: new Date() }).catch(() => {});
      req.otel = ctx;
      next();
    } catch (error) {
      next(error);
    }
  };
}
