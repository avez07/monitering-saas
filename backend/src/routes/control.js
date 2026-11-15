import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { assert } from '../lib/errors.js';
import {
  canAdmin,
  canEdit,
  permit,
  scopedRows,
  visibleProjects,
  requireProject,
  requireRow,
  audit,
} from '../services/auth.js';
import { billingProvider } from '../services/billing.js';
import { revokeAgentAccess } from '../services/agents.js';

const name = z.string().trim().min(2).max(100);
const id = z.string().min(1).max(100);
const nullableDate = z.string().datetime().nullable();

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
    const servers = rows.filter((r) => r.type === 'server');
    const sites = rows.filter((r) => r.type === 'uptime');
    const incidents = (await scopedRows(store, req.context, 'alertIncident')).filter(
      (r) =>
        ['firing', 'acknowledged'].includes(r.state) &&
        (!req.query.projectId || r.projectId === req.query.projectId),
    );
    res.json({
      servers: servers.length,
      healthyServers: servers.filter((r) => r.status === 'healthy').length,
      warningServers: servers.filter((r) => r.status === 'warning').length,
      offlineServers: servers.filter((r) => r.status === 'unhealthy').length,
      sites: sites.length,
      healthySites: sites.filter((r) => r.status === 'healthy').length,
      incidents: incidents.slice(0, 5),
      resources: servers.slice(0, 12),
    });
  });
  router.get('/resources', async (req, res) => {
    const filters = z
      .object({
        type: z.enum(['server', 'uptime']).optional(),
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
  // Servers are not created by hand: they appear when the agent registers with the account API key.
  router.delete('/resources/:id', canEdit, async (req, res) => {
    const row = await requireRow(store, req.context, 'monitoredResource', req.params.id);
    await store.update('monitoredResource', row.id, { deletedAt: new Date().toISOString() });
    // Removing a server must also stop its agent from reporting.
    if (row.type === 'server' && row.agentId) {
      const agent = await store.find('agent', { id: row.agentId });
      if (agent) await revokeAgentAccess(store, agent);
    }
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
          return {
            id: m.id,
            userId: m.userId,
            orgId: m.orgId,
            role: m.role,
            name: u.name,
            email: u.email,
            createdAt: m.createdAt,
          };
        }),
      ),
    );
  });
  router.patch('/members/:id', canAdmin, async (req, res) => {
    const member = await requireRow(store, req.context, 'organizationMember', req.params.id);
    assert(member.role !== 'owner', 403, 'Owner membership cannot be changed here.');
    const input = z.object({ role: z.enum(['admin', 'viewer']) }).strict().parse(req.body);
    // Only the owner manages administrators (changing one, or promoting someone to admin).
    if (req.context.membership.role !== 'owner')
      assert(
        member.role !== 'admin' && input.role !== 'admin',
        403,
        'Only the owner can manage administrators.',
      );
    const updated = await store.update('organizationMember', member.id, { role: input.role });
    await audit(store, req.context, 'member.role_changed', member.userId, { role: input.role });
    res.json({ id: updated.id, userId: updated.userId, orgId: updated.orgId, role: updated.role });
  });
  router.delete('/members/:id', canAdmin, async (req, res) => {
    const member = await requireRow(store, req.context, 'organizationMember', req.params.id);
    assert(
      member.role !== 'owner' && member.userId !== req.context.user.id,
      403,
      'You cannot remove this membership.',
    );
    if (req.context.membership.role !== 'owner')
      assert(member.role !== 'admin', 403, 'Only the owner can remove administrators.');
    // Access ends on their very next request: every request re-reads the membership.
    await store.remove('organizationMember', member.id);
    await audit(store, req.context, 'member.removed', member.userId);
    res.status(204).end();
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
