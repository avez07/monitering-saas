import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { assert } from '../lib/errors.js';
import { hashPassword } from '../lib/crypto.js';
import {
  canAdmin,
  requireMemberGrant,
  canEdit,
  permit,
  scopedRows,
  visibleProjects,
  requireProject,
  requireRow,
  audit,
} from '../services/auth.js';
import { enforceCount, entitlements } from '../services/limits.js';
import { resolveTarget, checkTarget } from '../services/uptime.js';
import { evaluateAlerts, deliverNotifications } from '../services/workers.js';
import { billingProvider } from '../services/billing.js';

const name = z.string().trim().min(2).max(100);
const id = z.string().min(1).max(100);
const nullableDate = z.string().datetime().nullable();
const resourceInput = z.object({
  name,
  projectId: id,
  type: z.enum(['server', 'container', 'application', 'database']),
  environment: z.string().min(1).max(40).default('production'),
  labels: z.record(z.union([z.string().max(200), z.number(), z.boolean()])).default({}),
});

export function controlRoutes(store, limits) {
  const router = Router();
  router.get('/bootstrap', async (req, res) => {
    const { orgId, user, membership } = req.context;
    const memberships = await store.list('organizationMember', { userId: user.id });
    const organizations = await Promise.all(
      memberships.map(async (m) => ({
        ...(await store.find('organization', { id: m.orgId })),
        role: m.role,
      })),
    );
    const subscription = await store.find('subscription', { orgId });
    res.json({
      user,
      organizations,
      organization: organizations.find((o) => o.id === orgId),
      role: membership.role,
      projects: await visibleProjects(store, req.context),
      subscription,
      plan: await store.find('subscriptionPlan', { id: subscription.planId }),
      demo: config.DEMO_MODE,
      billingProvider: billingProvider.name,
      apiPublicUrl: config.API_PUBLIC_URL,
    });
  });
  router.get('/overview', async (req, res) => {
    if (req.query.projectId) await requireProject(store, req.context, req.query.projectId);
    const rows = (await scopedRows(store, req.context, 'monitoredResource')).filter(
      (r) =>
        (!req.query.projectId || r.projectId === req.query.projectId) &&
        (!req.query.environment || r.environment === req.query.environment),
    );
    const byType = (type) => rows.filter((r) => r.type === type);
    const servers = byType('server'),
      containers = byType('container'),
      apps = byType('application');
    const sum = (key) => apps.reduce((a, r) => a + Number(r.labels?.[key] || 0), 0);
    const incidents = (await scopedRows(store, req.context, 'alertIncident')).filter(
      (r) =>
        ['firing', 'acknowledged'].includes(r.state) &&
        (!req.query.projectId || r.projectId === req.query.projectId),
    );
    res.json({
      source: config.DEMO_MODE ? 'demo' : 'live',
      servers: servers.length,
      healthyServers: servers.filter((r) => r.status === 'healthy').length,
      containers: containers.length,
      runningContainers: containers.filter((r) => r.status === 'running').length,
      applications: apps.length,
      throughput: sum('throughput'),
      errorRate: apps.length ? sum('errorRate') / apps.length : 0,
      p95: apps.length ? Math.max(...apps.map((a) => a.labels?.p95 || 0)) : 0,
      incidents: incidents.slice(0, 5),
      resources: rows.slice(0, 12),
      usage: await store.list('usageAggregate', { orgId: req.context.orgId }),
    });
  });
  router.get('/resources', async (req, res) => {
    const filters = z
      .object({
        type: z.enum(['server', 'container', 'application', 'database', 'uptime']).optional(),
        projectId: id.optional(),
        environment: z.string().max(40).optional(),
        search: z.string().max(200).optional(),
      })
      .parse(req.query);
    if (filters.projectId) await requireProject(store, req.context, filters.projectId);
    const rows = await scopedRows(store, req.context, 'monitoredResource');
    res.json(
      rows.filter((r) =>
        Object.entries(filters).every(([k, v]) =>
          k === 'search' ? r.name.toLowerCase().includes(v.toLowerCase()) : r[k] === v,
        ),
      ),
    );
  });
  router.post('/resources', canEdit, async (req, res) => {
    const input = resourceInput.parse(req.body);
    await requireProject(store, req.context, input.projectId);
    if (input.type === 'server' || input.type === 'container')
      await enforceCount(
        store,
        req.context.orgId,
        input.type === 'server' ? 'servers' : 'containers',
        (
          await store.list('monitoredResource', { orgId: req.context.orgId, type: input.type })
        ).filter((r) => !r.deletedAt).length,
      );
    const row = await store.create('monitoredResource', {
      ...input,
      orgId: req.context.orgId,
      status: 'pending',
    });
    await audit(store, req.context, 'resource.created', row.name);
    res.status(201).json(row);
  });
  router.delete('/resources/:id', canEdit, async (req, res) => {
    const row = await requireRow(store, req.context, 'monitoredResource', req.params.id);
    await store.update('monitoredResource', row.id, { deletedAt: new Date().toISOString() });
    await audit(store, req.context, 'resource.deleted', row.name);
    res.status(204).end();
  });
  router.get('/projects', async (req, res) => res.json(await visibleProjects(store, req.context)));
  router.post('/projects', canAdmin, async (req, res) => {
    const input = z.object({ name }).parse(req.body);
    const rows = await store.list('project', { orgId: req.context.orgId });
    assert(rows.length < 20, 400, 'This pilot supports up to 20 projects per organization.');
    const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    assert(!rows.some((r) => r.slug === slug), 409, 'A project with this name already exists.');
    const project = await store.create('project', {
      orgId: req.context.orgId,
      name: input.name,
      slug,
    });
    await store.create('environment', {
      orgId: req.context.orgId,
      projectId: project.id,
      name: 'production',
    });
    await audit(store, req.context, 'project.created', project.name);
    res.status(201).json(project);
  });
  router.get('/environments', async (req, res) =>
    res.json(await scopedRows(store, req.context, 'environment')),
  );
  router.post('/environments', canEdit, async (req, res) => {
    const input = z
      .object({ name: z.string().regex(/^[a-z0-9-]{2,40}$/), projectId: id })
      .parse(req.body);
    await requireProject(store, req.context, input.projectId);
    assert(
      !(await store.find('environment', { orgId: req.context.orgId, ...input })),
      409,
      'Environment already exists.',
    );
    res.status(201).json(await store.create('environment', { ...input, orgId: req.context.orgId }));
  });
  router.get('/members', canAdmin, async (req, res) => {
    const members = await store.list('organizationMember', { orgId: req.context.orgId });
    res.json(
      await Promise.all(
        members.map(async (m) => {
          const u = await store.find('user', { id: m.userId });
          return { ...m, name: u.name, email: u.email };
        }),
      ),
    );
  });
  router.post('/members', canAdmin, async (req, res) => {
    const input = z
      .object({
        name,
        email: z
          .string()
          .email()
          .transform((v) => v.toLowerCase()),
        password: z.string().min(10).max(128).optional(),
        role: z.enum(['admin', 'editor', 'viewer']),
        projectIds: z.array(id).max(20).default([]),
      })
      .parse(req.body);
    for (const p of input.projectIds) await requireProject(store, req.context, p);
    requireMemberGrant(req.context, input.role, input.projectIds);
    await enforceCount(
      store,
      req.context.orgId,
      'members',
      (await store.list('organizationMember', { orgId: req.context.orgId })).length,
    );
    const member = await store.transaction(async (tx) => {
      let user = await tx.find('user', { email: input.email });
      if (!user) {
        assert(input.password, 400, 'An initial password is required for a new account.');
        user = await tx.create('user', {
          name: input.name,
          email: input.email,
          passwordHash: hashPassword(input.password),
        });
      }
      assert(
        !(await tx.find('organizationMember', { orgId: req.context.orgId, userId: user.id })),
        409,
        'This user is already a member.',
      );
      return tx.create('organizationMember', {
        orgId: req.context.orgId,
        userId: user.id,
        role: input.role,
        projectIds: input.projectIds,
      });
    });
    await audit(store, req.context, 'member.added', input.email);
    res.status(201).json(member);
  });
  router.patch('/members/:id', canAdmin, async (req, res) => {
    const member = await requireRow(store, req.context, 'organizationMember', req.params.id);
    assert(member.role !== 'owner', 403, 'Owner membership cannot be changed here.');
    requireMemberGrant(req.context, member.role, member.projectIds);
    const input = z
      .object({
        role: z.enum(['admin', 'editor', 'viewer']),
        projectIds: z.array(id).max(20).default([]),
      })
      .parse(req.body);
    for (const p of input.projectIds) await requireProject(store, req.context, p);
    requireMemberGrant(req.context, input.role, input.projectIds);
    res.json(await store.update('organizationMember', member.id, input));
  });
  router.delete('/members/:id', canAdmin, async (req, res) => {
    const member = await requireRow(store, req.context, 'organizationMember', req.params.id);
    requireMemberGrant(req.context, member.role, member.projectIds);
    assert(
      member.role !== 'owner' && member.userId !== req.context.user.id,
      403,
      'You cannot remove this membership.',
    );
    await store.remove('organizationMember', member.id);
    await audit(store, req.context, 'member.removed', member.userId);
    res.status(204).end();
  });
  router.get('/alerts', async (req, res) =>
    res.json({
      rules: await scopedRows(store, req.context, 'alertRule'),
      incidents: (await scopedRows(store, req.context, 'alertIncident')).sort(
        (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
      ),
    }),
  );
  const ruleInput = z.object({
    name,
    projectId: id,
    metric: z.enum([
      'cpu',
      'memory',
      'disk',
      'restarts',
      'errorRate',
      'p95',
      'availability',
      'certificateDays',
    ]),
    operator: z.enum(['gt', 'lt']).default('gt'),
    threshold: z.coerce.number().finite(),
    durationSeconds: z.coerce.number().int().min(0).max(3600).default(60),
    cooldownSeconds: z.coerce.number().int().min(60).max(86400).default(300),
    severity: z.enum(['warning', 'critical']).default('warning'),
    enabled: z.boolean().default(true),
  });
  router.post('/alerts/rules', canEdit, async (req, res) => {
    const input = ruleInput.parse(req.body);
    await requireProject(store, req.context, input.projectId);
    await enforceCount(
      store,
      req.context.orgId,
      'alertRules',
      (await store.list('alertRule', { orgId: req.context.orgId })).length,
    );
    const row = await store.create('alertRule', { ...input, orgId: req.context.orgId });
    await audit(store, req.context, 'alert_rule.created', row.name);
    res.status(201).json(row);
  });
  router.patch('/alerts/rules/:id', canEdit, async (req, res) => {
    const rule = await requireRow(store, req.context, 'alertRule', req.params.id);
    const input = z
      .object({ enabled: z.boolean().optional(), silenceUntil: nullableDate.optional() })
      .parse(req.body);
    res.json(await store.update('alertRule', rule.id, input));
  });
  router.delete('/alerts/rules/:id', canEdit, async (req, res) => {
    const row = await requireRow(store, req.context, 'alertRule', req.params.id);
    await store.update('alertRule', row.id, { enabled: false });
    res.status(204).end();
  });
  router.patch('/alerts/incidents/:id', canEdit, async (req, res) => {
    const incident = await requireRow(store, req.context, 'alertIncident', req.params.id);
    const { state } = z.object({ state: z.enum(['acknowledged', 'resolved']) }).parse(req.body);
    res.json(
      await store.update('alertIncident', incident.id, {
        state,
        ...(state === 'resolved' ? { resolvedAt: new Date().toISOString() } : {}),
      }),
    );
  });
  router.post('/alerts/evaluate', canEdit, async (req, res) => {
    await limits.use(`evaluate:${req.context.orgId}`, 1, 5);
    await evaluateAlerts(store, req.context.orgId);
    await deliverNotifications(store, req.context.orgId);
    res.json({ message: 'Alert evaluation completed.' });
  });
  router.get('/notifications', canAdmin, async (req, res) =>
    res.json({
      channels: await store.list('notificationChannel', { orgId: req.context.orgId }),
      deliveries: (await store.list('notificationDelivery', { orgId: req.context.orgId }))
        .slice(-100)
        .reverse(),
      provider: config.EMAIL_PROVIDER,
    }),
  );
  router.post('/notifications/channels', canAdmin, async (req, res) => {
    const input = z.object({ name, address: z.string().email() }).parse(req.body);
    res.status(201).json(
      await store.create('notificationChannel', {
        ...input,
        orgId: req.context.orgId,
        type: 'email',
        enabled: true,
      }),
    );
  });
  router.patch('/notifications/channels/:id', canAdmin, async (req, res) => {
    const row = await requireRow(store, req.context, 'notificationChannel', req.params.id);
    res.json(
      await store.update(
        'notificationChannel',
        row.id,
        z.object({ enabled: z.boolean() }).parse(req.body),
      ),
    );
  });
  router.get('/uptime', async (req, res) =>
    res.json(await scopedRows(store, req.context, 'uptimeMonitor')),
  );
  router.post('/uptime', canEdit, async (req, res) => {
    const input = z
      .object({
        name,
        projectId: id,
        target: z.string().url().max(2048),
        intervalSeconds: z.coerce.number().int().min(60).max(86400).default(60),
        failureThreshold: z.coerce.number().int().min(1).max(10).default(3),
      })
      .parse(req.body);
    await requireProject(store, req.context, input.projectId);
    await resolveTarget(input.target);
    assert(
      (await store.list('uptimeMonitor', { orgId: req.context.orgId })).length < 100,
      402,
      'The pilot supports up to 100 uptime monitors.',
    );
    res.status(201).json(
      await store.create('uptimeMonitor', {
        ...input,
        orgId: req.context.orgId,
        enabled: true,
        status: 'pending',
        consecutiveFailures: 0,
      }),
    );
  });
  router.get('/uptime/:id/checks', async (req, res) => {
    const monitor = await requireRow(store, req.context, 'uptimeMonitor', req.params.id);
    res.json(
      (await store.list('uptimeCheck', { orgId: req.context.orgId, monitorId: monitor.id }))
        .slice(-100)
        .reverse(),
    );
  });
  router.post('/uptime/:id/check', canEdit, async (req, res) => {
    const monitor = await requireRow(store, req.context, 'uptimeMonitor', req.params.id);
    await limits.use(`uptime:${req.context.orgId}`, 1, 10);
    const result = await checkTarget(monitor.target);
    await store.create('uptimeCheck', {
      orgId: req.context.orgId,
      monitorId: monitor.id,
      ...result,
    });
    await store.update('uptimeMonitor', monitor.id, {
      status: result.ok ? 'healthy' : 'unhealthy',
      latencyMs: result.latencyMs,
      lastCheckedAt: new Date().toISOString(),
    });
    res.json(result);
  });
  router.patch('/uptime/:id', canEdit, async (req, res) => {
    const row = await requireRow(store, req.context, 'uptimeMonitor', req.params.id);
    res.json(
      await store.update(
        'uptimeMonitor',
        row.id,
        z.object({ enabled: z.boolean() }).parse(req.body),
      ),
    );
  });
  router.delete('/uptime/:id', canEdit, async (req, res) => {
    const row = await requireRow(store, req.context, 'uptimeMonitor', req.params.id);
    await store.remove('uptimeMonitor', row.id);
    res.status(204).end();
  });
  router.get('/billing', permit('owner', 'admin'), async (req, res) =>
    res.json({
      plans: await store.list('subscriptionPlan'),
      subscription: await store.find('subscription', { orgId: req.context.orgId }),
      invoices: await store.list('invoice', { orgId: req.context.orgId }),
      usage: await store.list('usageAggregate', { orgId: req.context.orgId }),
      provider: billingProvider.name,
    }),
  );
  router.post('/billing/change', permit('owner'), async (req, res) => {
    const input = z.object({ planId: id, interval: z.enum(['monthly', 'annual']) }).parse(req.body);
    const plan = await store.find('subscriptionPlan', { id: input.planId });
    assert(plan, 404, 'Plan not found.');
    for (const [type, key] of [
      ['server', 'servers'],
      ['container', 'containers'],
    ])
      assert(
        (await store.list('monitoredResource', { orgId: req.context.orgId, type })).filter(
          (r) => !r.deletedAt,
        ).length <= plan[key],
        400,
        `Remove resources before downgrading below the ${key} limit.`,
      );
    assert(
      (await store.list('organizationMember', { orgId: req.context.orgId })).length <= plan.members,
      400,
      'Remove team members before downgrading.',
    );
    assert(
      (await store.list('alertRule', { orgId: req.context.orgId })).length <= plan.alertRules,
      400,
      'Remove alert rules before downgrading.',
    );
    const invoice = await billingProvider.changeSubscription(
      store,
      req.context.orgId,
      plan,
      input.interval,
    );
    await audit(store, req.context, 'subscription.changed', plan.name, { provider: 'mock' });
    res.json({ invoice, message: 'Demo subscription updated. No money was charged.' });
  });
  router.post('/billing/cancel', permit('owner'), async (req, res) => {
    const row = await store.find('subscription', { orgId: req.context.orgId });
    res.json(await store.update('subscription', row.id, { cancelAtPeriodEnd: true }));
  });
  router.get('/settings', canAdmin, async (req, res) =>
    res.json(await store.find('organization', { id: req.context.orgId })),
  );
  router.patch('/settings', canAdmin, async (req, res) => {
    const input = z
      .object({
        name: name.optional(),
        settings: z
          .object({
            timezone: z.string().max(80).optional(),
            maintenanceUntil: nullableDate.optional(),
          })
          .optional(),
      })
      .parse(req.body);
    const org = await store.find('organization', { id: req.context.orgId });
    if (input.settings) input.settings = { ...org.settings, ...input.settings };
    res.json(await store.update('organization', org.id, input));
    await audit(store, req.context, 'settings.updated', org.name);
  });
  router.get('/audit', canAdmin, async (req, res) =>
    res.json((await store.list('auditLog', { orgId: req.context.orgId })).slice(-100).reverse()),
  );
  return router;
}
