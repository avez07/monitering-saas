import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
// A fixed hash lets login spend the same time on unknown accounts as on real ones.
const DUMMY_HASH = hashPassword('yuktiops-timing-equalizer');
export function verifyPassword(password, encoded) {
  const [salt, hash] = String(encoded || DUMMY_HASH).split(':');
  if (!salt || !/^[0-9a-f]{128}$/i.test(hash || '')) {
    scryptSync(password, 'invalid-hash-salt', 64);
    return false;
  }
  return timingSafeEqual(Buffer.from(hash, 'hex'), scryptSync(password, salt, 64));
}
/** Equalize timing when no account exists for the supplied email. */
export const burnPasswordCheck = (password) => verifyPassword(password, DUMMY_HASH) && false;
export const token = (prefix = 'yok') => `${prefix}_${randomBytes(32).toString('hex')}`;
export const digest = (value) => createHash('sha256').update(value).digest('hex');
