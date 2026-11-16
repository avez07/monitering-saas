import { assert } from '../lib/errors.js';
import { token, digest } from '../lib/crypto.js';

export const KEY_PREFIX = 'yk_live';
const TOUCH_EVERY_MS = 60000;

/** Create an active key. The raw value is returned once; only its hash is stored. */
export async function createApiKey(store, orgId, userId) {
  const raw = token(KEY_PREFIX);
  const row = await store.create('apiKey', {
    orgId,
    createdById: userId,
    kind: 'install',
    prefix: raw.slice(0, 12),
    tokenHash: digest(raw),
  });
  return { raw, row };
}
/** The organization's one active install key (telemetry keys are a separate kind, see otel-auth.js). */
export const activeApiKey = async (store, orgId) =>
  (await store.list('apiKey', { orgId, kind: 'install', revokedAt: null }))[0] || null;

/**
 * Authenticate an install/registration request with the account API key. Repeated wrong keys from
 * one address are throttled so the key space cannot be guessed.
 */
export function apiKeyAuth(store, limits) {
  return async (req, res, next) => {
    try {
      await limits.assertUnder(`v1:badkey:${req.ip}`, 20, 600);
      const raw = (req.headers.authorization || '').replace(/^Bearer /, '');
      const key =
        raw.startsWith(`${KEY_PREFIX}_`) &&
        (await store.find('apiKey', { tokenHash: digest(raw) }));
      if (!key || key.revokedAt || key.kind !== 'install') {
        await limits.record(`v1:badkey:${req.ip}`, 600);
        assert(false, 401, 'The API key is missing, wrong or has been revoked.');
      }
      if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > TOUCH_EVERY_MS)
        await store.update('apiKey', key.id, { lastUsedAt: new Date() });
      req.apiKey = key;
      next();
    } catch (error) {
      next(error);
    }
  };
}
