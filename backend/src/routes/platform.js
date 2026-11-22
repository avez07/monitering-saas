import { Router } from 'express';
import { z } from 'zod';
import { csrfGuard, platformAuth } from '../services/auth.js';
import {
  overview,
  listOrgs,
  orgDetail,
  changePlan,
  suspendOrg,
  reactivateOrg,
  listUsers,
  disableUser,
  enableUser,
  listAudit,
} from '../services/platform.js';

/**
 * Yukti platform admin API, mounted at /api/platform outside the org-scoped `secured` router
 * (no organization is needed). Every route requires a session whose user has isPlatformAdmin;
 * everyone else gets 403. See docs/api/advanced-telemetry.md section 7.
 */
const id = z.string().min(1).max(100);
const pageFields = {
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};
const q = z
  .string()
  .trim()
  .max(200)
  .optional()
  .transform((v) => v || undefined);
const note = z
  .string()
  .trim()
  .max(500)
  .optional()
  .transform((v) => v || undefined);

export function platformRoutes(store) {
  const router = Router();
  router.use(csrfGuard);
  router.use(platformAuth(store));
  const admin = (req) => req.context.admin;

  router.get('/overview', async (req, res) => res.json(await overview(store)));

  router.get('/orgs', async (req, res) => {
    const filters = z
      .object({
        q,
        plan: z
          .string()
          .max(40)
          .optional()
          .transform((v) => v || undefined),
        status: z
          .enum(['active', 'suspended', ''])
          .optional()
          .transform((v) => v || undefined),
        ...pageFields,
      })
      .parse(req.query);
    res.json(await listOrgs(store, filters));
  });

  router.get('/orgs/:id', async (req, res) =>
    res.json(await orgDetail(store, id.parse(req.params.id))),
  );

  router.post('/orgs/:id/plan', async (req, res) => {
    const input = z
      .object({
        planId: z.string().min(1).max(40),
        periodEnd: z.string().datetime({ offset: true }).optional(),
        note,
      })
      .strict()
      .parse(req.body);
    const result = await changePlan(store, admin(req), id.parse(req.params.id), input);
    res.json({
      subscription: result.subscription,
      plan: result.plan,
      warnings: result.warnings,
      message:
        result.action === 'org.plan_extended'
          ? `${result.plan.name} plan extended.`
          : `Plan changed to ${result.plan.name}.`,
    });
  });

  router.post('/orgs/:id/suspend', async (req, res) => {
    const { reason } = z
      .object({ reason: z.string().trim().min(3).max(500) })
      .strict()
      .parse(req.body);
    const org = await suspendOrg(store, admin(req), id.parse(req.params.id), reason);
    res.json({ organization: org, message: `${org.name} is suspended.` });
  });

  router.post('/orgs/:id/reactivate', async (req, res) => {
    const input = z
      .object({ note })
      .strict()
      .parse(req.body ?? {});
    const org = await reactivateOrg(store, admin(req), id.parse(req.params.id), input.note);
    res.json({ organization: org, message: `${org.name} is active again.` });
  });

  router.get('/users', async (req, res) => {
    const filters = z
      .object({
        q,
        status: z
          .enum(['active', 'disabled', 'staff', ''])
          .optional()
          .transform((v) => v || undefined),
        ...pageFields,
      })
      .parse(req.query);
    res.json(await listUsers(store, filters));
  });

  router.post('/users/:id/disable', async (req, res) => {
    const input = z
      .object({ reason: note })
      .strict()
      .parse(req.body ?? {});
    const user = await disableUser(store, admin(req), id.parse(req.params.id), input.reason);
    res.json({ user, message: `${user.email} is disabled and signed out everywhere.` });
  });

  router.post('/users/:id/enable', async (req, res) => {
    const user = await enableUser(store, admin(req), id.parse(req.params.id));
    res.json({ user, message: `${user.email} can sign in again.` });
  });

  router.get('/audit', async (req, res) => {
    const filters = z
      .object({
        targetType: z.enum(['organization', 'user']).optional(),
        targetId: id.optional(),
        action: z.string().max(60).optional(),
        ...pageFields,
      })
      .parse(req.query);
    res.json(await listAudit(store, filters));
  });

  router.use((req, res) => res.status(404).json({ error: 'Platform endpoint not found.' }));
  return router;
}
