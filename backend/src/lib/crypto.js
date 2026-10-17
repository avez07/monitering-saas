import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password, encoded) {
  const [salt, hash] = encoded.split(':');
  return timingSafeEqual(Buffer.from(hash, 'hex'), scryptSync(password, salt, 64));
}
export const token = (prefix = 'pls') => `${prefix}_${randomBytes(32).toString('hex')}`;
export const digest = (value) => createHash('sha256').update(value).digest('hex');
