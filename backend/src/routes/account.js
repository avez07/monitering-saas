import { Router } from 'express';
import { z } from 'zod';
import { assert } from '../lib/errors.js';
import { hashPassword } from '../lib/crypto.js';
import { csrfGuard, resolveSession, endAllSessions } from '../services/auth.js';
import { issueToken, consumeToken, VERIFY_TTL_MS, RESET_TTL_MS } from '../services/account-tokens.js';
import { sendVerificationEmail, sendPasswordResetEmail } from '../services/mail.js';

const email = z
  .string()
  .trim()
  .email()
  .max(200)
  .transform((v) => v.toLowerCase());
const BAD_LINK = 'This link is invalid or has expired.';

export const sendVerification = async (store, user) =>
  sendVerificationEmail({
    to: user.email,
    name: user.name,
    token: await issueToken(store, user.id, 'email_verify', VERIFY_TTL_MS),
  });

/** Email verification and password reset, mounted under /api/auth. */
export function accountRoutes(store, limits) {
  const router = Router();
  router.use(csrfGuard);

  router.post('/verify-email', async (req, res) => {
    await limits.use(`verify:${req.ip}`, 1, 30, 600);
    const { token } = z.object({ token: z.string().min(1).max(200) }).parse(req.body);
    const userId = await consumeToken(store, 'email_verify', token);
    assert(userId, 400, BAD_LINK);
    const user = await store.find('user', { id: userId });
    if (!user.emailVerifiedAt) await store.update('user', userId, { emailVerifiedAt: new Date() });
    res.json({ verified: true });
  });

  router.post('/resend-verification', async (req, res) => {
    const user = await resolveSession(store, req);
    if (user.emailVerifiedAt) return res.json({ sent: false, alreadyVerified: true });
    await limits.use(`resend-verify:${user.id}`, 1, 3, 3600);
    await sendVerification(store, user);
    res.json({ sent: true });
  });

  router.post('/forgot-password', async (req, res) => {
    await limits.use(`forgot:ip:${req.ip}`, 1, 20, 3600);
    const input = z.object({ email }).parse(req.body);
    await limits.use(`forgot:email:${input.email}`, 1, 3, 3600);
    const user = await store.find('user', { email: input.email });
    if (user)
      await sendPasswordResetEmail({
        to: user.email,
        name: user.name,
        token: await issueToken(store, user.id, 'password_reset', RESET_TTL_MS),
      });
    // The same answer whether or not the account exists, so this cannot be used to find accounts.
    res.json({ message: 'If that email has an account, a reset link is on its way.' });
  });

  router.post('/reset-password', async (req, res) => {
    await limits.use(`reset:${req.ip}`, 1, 20, 3600);
    const input = z
      .object({ token: z.string().min(1).max(200), password: z.string().min(10).max(128) })
      .parse(req.body);
    const userId = await consumeToken(store, 'password_reset', input.token);
    assert(userId, 400, BAD_LINK);
    const user = await store.find('user', { id: userId });
    await store.update('user', userId, {
      passwordHash: hashPassword(input.password),
      // Receiving the reset email proves they own the address.
      ...(user.emailVerifiedAt ? {} : { emailVerifiedAt: new Date() }),
    });
    await endAllSessions(store, userId);
    res.json({ reset: true });
  });
  return router;
}
