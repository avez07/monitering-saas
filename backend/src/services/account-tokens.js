import { token as newToken, digest } from '../lib/crypto.js';

export const VERIFY_TTL_MS = 3 * 86400000;
export const RESET_TTL_MS = 3600000;

/** Create a single-use token of `kind`. Older unused tokens of the same kind stop working. Returns the raw value. */
export async function issueToken(store, userId, kind, ttlMs) {
  await store.updateMany('accountToken', { userId, kind, usedAt: null }, { usedAt: new Date() });
  const raw = newToken(kind === 'password_reset' ? 'rst' : 'vfy');
  await store.create('accountToken', {
    userId,
    kind,
    tokenHash: digest(raw),
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return raw;
}

/** Atomically use a token. Returns its user id, or null when it is unknown, expired or already used. */
export async function consumeToken(store, kind, raw) {
  const row = await store.find('accountToken', { kind, tokenHash: digest(String(raw)) });
  if (!row) return null;
  const claimed = await store.claim(
    'accountToken',
    row.id,
    { usedAt: null, expiresAt: { gt: new Date() } },
    { usedAt: new Date() },
  );
  return claimed ? row.userId : null;
}
