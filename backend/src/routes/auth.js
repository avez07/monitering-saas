import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { assert } from '../lib/errors.js';
import { hashPassword, verifyPassword, burnPasswordCheck } from '../lib/crypto.js';
import { defaultSettings, newConfigId } from '../services/agent-config.js';
import {
  csrfGuard,
  startSession,
  endSession,
  endAllSessions,
  clearSessionCookie,
  resolveSession,
  publicUser,
} from '../services/auth.js';

const email = z
  .string()
  .email()
  .transform((v) => v.toLowerCase());

export function authRoutes(store, limits) {
  const router = Router();
  router.use(csrfGuard);
  router.get('/config', (req, res) =>
    res.json({ billing: config.BILLING_PROVIDER, email: config.EMAIL_PROVIDER }),
  );
  router.get('/me', async (req, res) => {
    res.json({ user: publicUser(await resolveSession(store, req)) });
  });
  router.post('/login', async (req, res) => {
    await limits.use(`login:ip:${req.ip}`, 1, 30, 300);
    const input = z.object({ email, password: z.string().min(1).max(256) }).parse(req.body);
    // Lock a single account after repeated failures, whatever IP the attempts come from.
    await limits.assertUnder(
      `login:fail:${input.email}`,
      10,
      900,
      'Too many failed sign-in attempts for this account. Try again in 15 minutes.',
    );
    const user = await store.find('user', { email: input.email });
    const valid = user
      ? verifyPassword(input.password, user.passwordHash)
      : burnPasswordCheck(input.password);
    if (!valid) {
      await limits.record(`login:fail:${input.email}`, 900);
      assert(false, 401, 'Email or password is incorrect.');
    }
    await startSession(store, req, res, user);
    res.json({ user: publicUser(user) });
  });
  router.post('/register', async (req, res) => {
    await limits.use(`register:${req.ip}`, 1, 10, 3600);
    const input = z
      .object({
        name: z.string().trim().min(2).max(80),
        email,
        password: z.string().min(10).max(128),
        organization: z.string().trim().min(2).max(80),
      })
      .parse(req.body);
    assert(
      !(await store.find('user', { email: input.email })),
      409,
      'This email is already registered.',
    );
    const user = await store.transaction(async (tx) => {
      const user = await tx.create('user', {
        name: input.name,
        email: input.email,
        passwordHash: hashPassword(input.password),
      });
      const org = await tx.create('organization', {
        name: input.organization,
        slug: `${input.organization.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${user.id.slice(0, 6)}`,
        settings: {},
      });
      await tx.create('organizationMember', {
        orgId: org.id,
        userId: user.id,
        role: 'owner',
        projectIds: [],
      });
      const project = await tx.create('project', {
        orgId: org.id,
        name: 'My Project',
        slug: 'my-project',
      });
      await tx.create('environment', { orgId: org.id, projectId: project.id, name: 'production' });
      await tx.create('agentConfig', {
        id: newConfigId(),
        orgId: org.id,
        name: 'Default',
        isDefault: true,
        settings: defaultSettings(),
      });
      await tx.create('subscription', {
        orgId: org.id,
        planId: 'free',
        status: 'active',
        interval: 'monthly',
        periodEnd: new Date(Date.now() + 3650 * 86400000),
        cancelAtPeriodEnd: false,
      });
      await tx.create('notificationChannel', {
        orgId: org.id,
        name: 'Owner email',
        type: 'email',
        address: user.email,
        enabled: true,
      });
      return user;
    });
    await startSession(store, req, res, user);
    res.status(201).json({ user: publicUser(user) });
  });
  router.post('/logout', async (req, res) => {
    await endSession(store, req);
    clearSessionCookie(res);
    res.status(204).end();
  });
  router.post('/logout-all', async (req, res) => {
    const user = await resolveSession(store, req);
    await endAllSessions(store, user.id);
    clearSessionCookie(res);
    res.status(204).end();
  });
  return router;
}
