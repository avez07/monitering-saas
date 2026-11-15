import { Router } from 'express';
import { z } from 'zod';
import { assert } from '../lib/errors.js';
import { canEdit, audit } from '../services/auth.js';
import { enforceCount, entitlements } from '../services/limits.js';
import { metricSources, templates, normalizeRule, ruleSummary } from '../services/alert-metrics.js';
import {
  evaluateAlerts,
  ruleToApi,
  incidentToApi,
  templateByKey,
  templateRule,
} from '../services/alerting.js';
import { deliverNotifications } from '../services/contacts.js';

const id = z.string().min(1).max(100);
const ruleFields = {
  name: z.string().trim().min(2).max(100),
  metric: z.string().refine((m) => metricSources.has(m), 'Unknown metric.'),
  operator: z.enum(['gt', 'lt']),
  threshold: z.coerce.number().finite().min(0).max(1_000_000),
  durationMinutes: z.coerce.number().min(0).max(60),
  cooldownMinutes: z.coerce.number().min(1).max(1440),
  severity: z.enum(['warning', 'critical']),
  scope: z.object({ type: z.enum(['all', 'selected']), ids: z.array(id).max(200).default([]) }),
  contactIds: z.array(id).max(50),
  enabled: z.boolean(),
};
const createInput = z
  .object({ ...ruleFields, templateKey: z.string().max(60).optional() })
  .partial()
  .required({ metric: true });
const updateInput = z
  .object({ ...ruleFields, silenceUntil: z.string().datetime().nullable() })
  .partial();

export function alertRoutes(store, limits) {
  const router = Router();
  const org = (req) => req.context.orgId;

  async function defaultProjectId(orgId) {
    const projects = await store.list('project', { orgId });
    const project = projects.filter((p) => !p.deletedAt).sort((a, b) => a.createdAt - b.createdAt)[0];
    assert(project, 400, 'This organization has no project yet.');
    return project.id;
  }
  /** Check that selected ids and contacts belong to this organization; store canonical ids. */
  async function checkReferences(orgId, kind, scope, contactIds) {
    let ids = scope?.ids ?? [];
    if (scope?.type === 'selected') {
      assert(ids.length > 0, 400, 'Pick at least one server or website, or choose all.');
      if (kind === 'server') {
        const resources = (await store.list('monitoredResource', { orgId, type: 'server' })).filter((r) => !r.deletedAt);
        ids = ids.map((i) => {
          const hit = resources.find((r) => r.agentId === i || r.id === i);
          assert(hit, 400, 'One of the selected servers was not found.');
          return hit.agentId ?? hit.id;
        });
      } else {
        const monitors = await store.list('uptimeMonitor', { orgId });
        ids = ids.map((i) => {
          const hit = monitors.find((m) => m.id === i);
          assert(hit, 400, 'One of the selected websites was not found.');
          return hit.id;
        });
      }
    }
    if (contactIds?.length) {
      const contacts = await store.list('notificationChannel', { orgId });
      for (const c of contactIds)
        assert(contacts.some((x) => x.id === c), 400, 'One of the selected contacts was not found.');
    }
    return scope ? { type: scope.type, ids } : undefined;
  }
  const listRules = (orgId) =>
    store.client.alertRule.findMany({ where: { orgId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
  async function present(orgId, rules) {
    const contacts = await store.list('notificationChannel', { orgId });
    const open = await store.client.alertIncident.groupBy({
      by: ['ruleId'],
      where: { orgId, state: { in: ['pending', 'firing', 'acknowledged'] } },
      _count: true,
    });
    const counts = new Map(open.map((o) => [o.ruleId, o._count]));
    return rules.map((r) => ruleToApi(r, { contacts, open: counts.get(r.id) ?? 0 }));
  }

  router.get('/alerts/metrics', async (req, res) => {
    const items = [];
    for (const [key, s] of metricSources)
      items.push({ key, label: s.label, kind: s.kind, unit: s.unit, available: await s.available(store, org(req)), defaults: s.defaults });
    res.json({ items });
  });

  router.get('/alerts/templates', async (req, res) => {
    const existing = new Set((await listRules(org(req))).map((r) => r.templateKey).filter(Boolean));
    const items = [];
    for (const t of templates) {
      const rule = templateRule(t);
      const source = metricSources.get(t.metric);
      const stored = normalizeRule(rule);
      items.push({
        key: t.key,
        name: t.name,
        description: t.description,
        kind: source.kind,
        available: await source.available(store, org(req)),
        alreadyCreated: existing.has(t.key),
        rule: {
          metric: t.metric,
          operator: stored.operator,
          threshold: stored.threshold,
          durationMinutes: stored.durationSeconds / 60,
          severity: stored.severity,
        },
        summary: ruleSummary({ ...stored, name: t.name }),
      });
    }
    res.json({ items });
  });

  router.get('/alerts/rules', async (req, res) => {
    const rules = await listRules(org(req));
    const { plan } = await entitlements(store, org(req));
    res.json({ items: await present(org(req), rules), limit: { used: rules.length, max: plan.alertRules } });
  });

  async function createRule(req, res, input, templateKey) {
    const orgId = org(req);
    const source = metricSources.get(input.metric);
    await enforceCount(store, orgId, 'alertRules', (await listRules(orgId)).length);
    const scope = (await checkReferences(orgId, source.kind, input.scope, input.contactIds)) ?? { type: 'all', ids: [] };
    const row = await store.create('alertRule', {
      orgId,
      projectId: await defaultProjectId(orgId),
      name: input.name ?? source.label,
      templateKey: templateKey ?? null,
      enabled: input.enabled ?? true,
      ...normalizeRule({ ...input, scope }),
    });
    await audit(store, req.context, 'alert_rule.created', row.name);
    res.status(201).json((await present(orgId, [row]))[0]);
  }
  router.post('/alerts/rules', canEdit, async (req, res) => {
    const input = createInput.parse(req.body);
    await createRule(req, res, input, input.templateKey);
  });
  router.post('/alerts/rules/from-template', canEdit, async (req, res) => {
    const { templateKey, ...rest } = z
      .object({ templateKey: z.string() })
      .passthrough()
      .parse(req.body);
    const template = templateByKey(templateKey);
    assert(template, 400, 'Unknown template.');
    const overrides = createInput.partial().parse(rest);
    await createRule(req, res, { ...templateRule(template), ...overrides, metric: template.metric }, template.key);
  });
  router.patch('/alerts/rules/:id', canEdit, async (req, res) => {
    const rule = await store.client.alertRule.findFirst({
      where: { id: req.params.id, orgId: org(req), deletedAt: null },
    });
    assert(rule, 404, 'Rule not found.');
    const input = updateInput.parse(req.body);
    const metric = input.metric ?? rule.metric;
    const source = metricSources.get(metric);
    const scope = await checkReferences(
      org(req),
      source.kind,
      input.scope ?? (input.metric ? { type: rule.scopeType, ids: rule.scopeIds } : undefined),
      input.contactIds,
    );
    const data = {
      ...normalizeRule({ ...input, scope, metric }, metric === rule.metric ? rule : { cooldownSeconds: rule.cooldownSeconds, contactIds: rule.contactIds }),
      ...(input.name ? { name: input.name } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.silenceUntil !== undefined ? { silenceUntil: input.silenceUntil ? new Date(input.silenceUntil) : null } : {}),
    };
    const row = await store.update('alertRule', rule.id, data);
    res.json((await present(org(req), [row]))[0]);
  });
  router.delete('/alerts/rules/:id', canEdit, async (req, res) => {
    const rule = await store.client.alertRule.findFirst({
      where: { id: req.params.id, orgId: org(req), deletedAt: null },
    });
    assert(rule, 404, 'Rule not found.');
    // History is kept; the evaluator closes this rule's open incidents quietly on its next pass.
    await store.update('alertRule', rule.id, { deletedAt: new Date(), enabled: false });
    await store.client.alertIncident.updateMany({
      where: { ruleId: rule.id, state: { in: ['pending', 'firing', 'acknowledged'] } },
      data: { state: 'resolved', resolvedAt: new Date() },
    });
    await audit(store, req.context, 'alert_rule.deleted', rule.name);
    res.status(204).end();
  });

  const OPEN = ['pending', 'firing', 'acknowledged'];
  async function presentIncidents(orgId, rows) {
    const rules = new Map(
      (await store.client.alertRule.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.ruleId))] } } })).map((r) => [r.id, r]),
    );
    const resources = new Map(
      (await store.client.monitoredResource.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.resourceId))] } } })).map((r) => [r.id, r]),
    );
    return rows.map((i) => incidentToApi(i, rules.get(i.ruleId), resources.get(i.resourceId)));
  }
  router.get('/alerts/incidents', async (req, res) => {
    const q = z
      .object({
        state: z.enum(['open', 'firing', 'acknowledged', 'resolved']).optional(),
        ruleId: id.optional(),
        resourceId: id.optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        before: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    const where = { orgId: org(req) };
    if (q.state === 'open') where.state = { in: OPEN };
    else if (q.state === 'firing') where.state = { in: ['pending', 'firing'] };
    else if (q.state) where.state = q.state;
    if (q.ruleId) where.ruleId = q.ruleId;
    if (q.resourceId) where.resourceId = q.resourceId;
    const started = {};
    if (q.from) started.gte = new Date(q.from);
    if (q.to) started.lte = new Date(q.to);
    if (q.before) started.lt = new Date(q.before);
    if (Object.keys(started).length) where.startedAt = started;
    const rows = await store.client.alertIncident.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: q.limit + 1,
    });
    const more = rows.length > q.limit;
    const page = rows.slice(0, q.limit);
    res.json({
      items: await presentIncidents(org(req), page),
      nextBefore: more ? page.at(-1).startedAt : null,
    });
  });
  router.get('/alerts/summary', async (req, res) => {
    const where = { orgId: org(req) };
    const [firing, acknowledged, recent] = await Promise.all([
      store.client.alertIncident.count({ where: { ...where, state: { in: ['pending', 'firing'] } } }),
      store.client.alertIncident.count({ where: { ...where, state: 'acknowledged' } }),
      store.client.alertIncident.findMany({ where, orderBy: { startedAt: 'desc' }, take: 5 }),
    ]);
    res.json({ firing, acknowledged, recent: await presentIncidents(org(req), recent) });
  });
  router.patch('/alerts/incidents/:id', canEdit, async (req, res) => {
    const incident = await store.find('alertIncident', { id: req.params.id, orgId: org(req) });
    assert(incident, 404, 'Alert not found.');
    const { state } = z.object({ state: z.enum(['acknowledged', 'resolved']) }).parse(req.body);
    assert(incident.state !== 'resolved', 409, 'This alert is already resolved.');
    const now = new Date();
    const row = await store.update('alertIncident', incident.id, {
      state,
      ...(state === 'acknowledged' ? { acknowledgedAt: now } : { resolvedAt: now }),
    });
    await audit(store, req.context, `alert.${state}`, incident.name);
    res.json((await presentIncidents(org(req), [row]))[0]);
  });
  router.post('/alerts/evaluate', canEdit, async (req, res) => {
    await limits.use(`evaluate:${org(req)}`, 1, 5);
    await evaluateAlerts(store, org(req));
    await deliverNotifications(store, org(req));
    res.json({ message: 'Alert evaluation completed.' });
  });
  return router;
}
