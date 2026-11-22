import { randomBytes } from 'node:crypto';
import { hashPassword } from '../lib/crypto.js';

/**
 * Staff accounts for the Yukti platform admin, used by `npm run admin:create` / `admin:revoke`
 * (backend/scripts/admin.mjs). The flag is never granted through the HTTP API.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const generatePassword = () => randomBytes(18).toString('base64url');

function cliAudit(store, user, action, details) {
  // The CLI has no signed-in admin; the row names the account itself and says it came from the CLI.
  return store.create('platformAuditLog', {
    adminUserId: user.id,
    action,
    targetType: 'user',
    targetId: user.id,
    details: { via: 'cli', ...details },
  });
}

/**
 * Create a staff user or promote an existing one. A new user gets `password`, or a generated one that is
 * returned once (only its hash is stored). An existing user's password changes only when one is given.
 * Returns { user, created, password? }.
 */
export async function grantPlatformAdmin(store, { email, password, name }) {
  email = String(email || '')
    .trim()
    .toLowerCase();
  if (!EMAIL.test(email)) throw new Error('Give a valid email address.');
  if (password !== undefined && (password.length < 10 || password.length > 128))
    throw new Error('The password must be 10 to 128 characters.');
  const existing = await store.find('user', { email });
  if (existing) {
    const user = await store.update('user', existing.id, {
      isPlatformAdmin: true,
      ...(password ? { passwordHash: hashPassword(password) } : {}),
    });
    await cliAudit(store, user, 'admin.granted', { email, passwordChanged: Boolean(password) });
    return { user, created: false };
  }
  const plain = password || generatePassword();
  const user = await store.create('user', {
    name: name || email.split('@')[0],
    email,
    passwordHash: hashPassword(plain),
    emailVerifiedAt: new Date(), // staff accounts are created by an operator, not by sign-up
    isPlatformAdmin: true,
  });
  await cliAudit(store, user, 'admin.granted', { email, created: true });
  return { user, created: true, ...(password ? {} : { password: plain }) };
}

/** Remove the staff flag. The user keeps their account and organizations. */
export async function revokePlatformAdmin(store, email) {
  email = String(email || '')
    .trim()
    .toLowerCase();
  const user = await store.find('user', { email });
  if (!user) throw new Error(`No user with email ${email}.`);
  if (!user.isPlatformAdmin) return { user, changed: false };
  const updated = await store.update('user', user.id, { isPlatformAdmin: false });
  await cliAudit(store, user, 'admin.revoked', { email });
  return { user: updated, changed: true };
}
