import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { assert } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { sessionToken, publicUser } from '../services/auth.js';

export function authRoutes(store, limits) {
  const router = Router();
  router.get('/config', (req, res) =>
    res.json({
      demo: config.DEMO_MODE,
      billing: config.BILLING_PROVIDER,
      email: config.EMAIL_PROVIDER,
    }),
  );
  router.post('/login', async (req, res) => {
    await limits.use(`login:${req.ip}`, 1, 20, 300);
    const input = z
      .object({
        email: z
          .string()
          .email()
          .transform((v) => v.toLowerCase()),
        password: z.string().min(1).max(256),
      })
      .parse(req.body);
    const user = await store.find('user', { email: input.email });
    assert(
      user && verifyPassword(input.password, user.passwordHash),
      401,
      'Email or password is incorrect.',
    );
    res.json({ token: sessionToken(user), user: publicUser(user) });
  });
  router.post('/demo', async (req, res) => {
    assert(config.DEMO_MODE, 404, 'Demo login is disabled.');
    const user = await store.find('user', { email: config.DEMO_EMAIL });
    assert(user, 503, 'Demo data is not available.');
    res.json({ token: sessionToken(user), user: publicUser(user) });
  });
  router.post('/register', async (req, res) => {
    await limits.use(`register:${req.ip}`, 1, 10, 3600);
    const input = z
      .object({
        name: z.string().trim().min(2).max(80),
        email: z
          .string()
          .email()
          .transform((v) => v.toLowerCase()),
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
      await tx.create('subscription', {
        orgId: org.id,
        planId: 'starter',
        status: 'trialing',
        interval: 'monthly',
        periodEnd: new Date(Date.now() + 14 * 86400000).toISOString(),
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
    res.status(201).json({ token: sessionToken(user), user: publicUser(user) });
  });
  return router;
}
