import { config } from '../config.js';
import { metricSources, templates, DEFAULT_TEMPLATE_KEYS, normalizeRule, ruleSummary } from './alert-metrics.js';
import { ensureResource } from './checks.js';

export const RECOVERY_MS = 60000; // an alert only closes after the problem stayed gone this long
const OPEN = ['pending', 'firing', 'acknowledged'];

const minutesOf = (seconds) => Math.round(seconds / 60);

export function templateByKey(key) {
  return templates.find((t) => t.key === key);
}
/** The rule fields a template creates (plain API input shape). */
export function templateRule(template) {
  const d = metricSources.get(template.metric).defaults;
  return {
    name: template.name,
    templateKey: template.key,
    metric: template.metric,
    operator: d.operator,
    threshold: d.threshold,
    durationMinutes: d.durationMinutes,
    severity: d.severity,
  };
}

/** New organizations start with these three active rules (the website rule applies once a site exists). */
export async function createDefaultRules(store, orgId, projectId) {
  for (const key of DEFAULT_TEMPLATE_KEYS) {
    const template = templateByKey(key);
    const input = templateRule(template);
    await store.create('alertRule', {
      orgId,
      projectId,
      name: template.name,
      templateKey: key,
      enabled: true,
      ...normalizeRule(input),
    });
  }
}

export function ruleToApi(rule, { contacts = [], open = 0 } = {}) {
  const source = metricSources.get(rule.metric);
  const selected = rule.contactIds?.length > 0;
  const chosen = selected ? contacts.filter((c) => rule.contactIds.includes(c.id)) : contacts.filter((c) => c.enabled);
  const labels = { email: 'Email', telegram: 'Telegram', slack: 'Slack', discord: 'Discord', webhook: 'Webhook' };
  const types = [...new Set(chosen.map((c) => labels[c.type] ?? c.type))];
  return {
    id: rule.id,
    name: rule.name,
    templateKey: rule.templateKey ?? null,
    enabled: rule.enabled,
    metric: rule.metric,
    kind: source?.kind ?? 'server',
    operator: rule.operator,
    threshold: rule.threshold,
    durationMinutes: minutesOf(rule.durationSeconds),
    severity: rule.severity,
    cooldownMinutes: minutesOf(rule.cooldownSeconds),
    scope: { type: rule.scopeType, ids: rule.scopeIds },
    contactIds: rule.contactIds ?? [],
    contacts: selected ? 'selected' : 'all',
    silenceUntil: rule.silenceUntil,
    summary: ruleSummary(rule),
    sendTo: types.length ? types.join(', ') : selected ? 'no contacts' : 'all your contacts',
    openIncidents: open,
    createdAt: rule.createdAt,
  };
}

export function incidentToApi(incident, rule, resource) {
  const source = metricSources.get(rule?.metric);
  return {
    id: incident.id,
    ruleId: incident.ruleId,
    ruleName: rule?.name ?? null,
    name: incident.name,
    metric: rule?.metric ?? null,
    severity: incident.severity,
    state: incident.state === 'pending' ? 'firing' : incident.state,
    value: incident.value,
    valueText: source ? source.format(incident.value) : String(incident.value),
    resource: resource
      ? { id: resource.id, name: resource.name, kind: resource.type === 'server' ? 'server' : 'website' }
      : null,
    startedAt: incident.startedAt,
    acknowledgedAt: incident.acknowledgedAt,
    resolvedAt: incident.resolvedAt,
    lastNotifiedAt: incident.lastNotifiedAt,
    notified: incident.notified,
  };
}

/** Queue a notification for every contact the rule routes to. Maintenance windows queue nothing. */
export async function enqueueNotifications(store, incident, { rule, detail, recovery = false, now = Date.now() } = {}) {
  const org = await store.find('organization', { id: incident.orgId });
  if (org.settings?.maintenanceUntil && new Date(org.settings.maintenanceUntil) > new Date(now)) return 0;
  rule ??= await store.find('alertRule', { id: incident.ruleId });
  const chosen = rule.contactIds?.length ? new Set(rule.contactIds) : null;
  const channels = (await store.list('notificationChannel', { orgId: incident.orgId, enabled: true })).filter(
    (c) => c.address && (!chosen || chosen.has(c.id)),
  );
  const source = metricSources.get(rule.metric);
  const what = detail ?? `${source?.format(incident.value) ?? incident.value} (${ruleSummary(rule)})`;
  const label = recovery ? 'Recovered' : incident.severity === 'critical' ? 'CRITICAL' : 'WARNING';
  const subject = `[${label}] ${incident.name}`;
  const body = recovery
    ? `${incident.name} is back to normal.\n${what}\nOpen ${config.APP_URL}/alerts`
    : `${incident.name}\n${what}\nOpen ${config.APP_URL}/alerts`;
  const payload = {
    event: recovery ? 'alert.resolved' : 'alert.fired',
    sentAt: new Date(now).toISOString(),
    incident: {
      id: incident.id,
      name: incident.name,
      severity: incident.severity,
      state: recovery ? 'resolved' : 'firing',
      value: incident.value,
      startedAt: incident.startedAt,
    },
    message: body,
    url: `${config.APP_URL}/alerts`,
  };
  for (const channel of channels)
    await store.create('notificationDelivery', {
      orgId: incident.orgId,
      incidentId: incident.id,
      channelId: channel.id,
      address: channel.address,
      subject,
      body,
      payload,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(now),
    });
  return channels.length;
}

async function loadSubjects(store, orgId) {
  const client = store.client;
  const resources = await client.monitoredResource.findMany({ where: { orgId, deletedAt: null } });
  const agents = await client.agent.findMany({ where: { orgId, status: { not: 'revoked' } } });
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const servers = resources
    .filter((r) => r.type === 'server' && r.agentId && agentById.has(r.agentId))
    .map((resource) => ({ kind: 'server', resource, agent: agentById.get(resource.agentId) }));
  const monitors = await client.uptimeMonitor.findMany({ where: { orgId, enabled: true } });
  const resourceOf = new Map(resources.filter((r) => r.type === 'uptime').map((r) => [r.externalId, r]));
  const websites = [];
  for (const monitor of monitors) {
    const resource = await ensureResource(store, monitor, resourceOf.get(monitor.id));
    websites.push({ kind: 'website', monitor, resource });
  }
  return { server: servers, website: websites };
}
const inScope = (rule, subject) =>
  rule.scopeType !== 'selected' ||
  (subject.kind === 'server'
    ? rule.scopeIds.includes(subject.agent.id) || rule.scopeIds.includes(subject.resource.id)
    : rule.scopeIds.includes(subject.monitor.id) || rule.scopeIds.includes(subject.resource.id));

/**
 * Evaluate every enabled rule for one organization (or all). Fires, recovers, holds off flapping with a
 * recovery delay, and respects cooldown. `now` is injectable so tests can move the clock.
 */
export async function evaluateAlerts(store, orgId, { now = Date.now() } = {}) {
  const rules = await store.client.alertRule.findMany({
    where: { enabled: true, deletedAt: null, ...(orgId ? { orgId } : {}) },
  });
  const openAll = await store.client.alertIncident.findMany({
    where: { state: { in: OPEN }, ...(orgId ? { orgId } : {}) },
    select: { orgId: true },
    distinct: ['orgId'],
  });
  const orgs = [...new Set([...rules.map((r) => r.orgId), ...openAll.map((i) => i.orgId)])];
  for (const id of orgs) {
    const subjects = await loadSubjects(store, id);
    const ctx = { store, now };
    const open = await store.client.alertIncident.findMany({ where: { orgId: id, state: { in: OPEN } } });
    const openBy = new Map(open.map((i) => [`${i.ruleId}:${i.resourceId}`, i]));
    const kept = new Set();
    for (const rule of rules.filter((r) => r.orgId === id)) {
      const source = metricSources.get(rule.metric);
      if (!source) continue;
      for (const subject of subjects[source.kind].filter((s) => inScope(rule, s))) {
        const key = `${rule.id}:${subject.resource.id}`;
        kept.add(key);
        let result;
        try {
          result = await source.evaluate(ctx, rule, subject);
        } catch (error) {
          console.error(`Alert ${rule.metric}:`, error.message);
          continue;
        }
        await apply(ctx, rule, subject, result, openBy.get(key));
      }
    }
    // Incidents whose rule was disabled or deleted, or whose server/website was removed, close quietly.
    for (const incident of open)
      if (!kept.has(`${incident.ruleId}:${incident.resourceId}`))
        await store.update('alertIncident', incident.id, { state: 'resolved', resolvedAt: new Date(now) });
  }
}

async function apply(ctx, rule, subject, result, incident) {
  const { store, now } = ctx;
  const at = new Date(now);
  const resource = subject.resource;
  const silenced = rule.silenceUntil && new Date(rule.silenceUntil) > at;
  if (!incident) {
    if (result.fire !== true) return;
    incident = await store.create('alertIncident', {
      orgId: rule.orgId,
      projectId: rule.projectId,
      ruleId: rule.id,
      resourceId: resource.id,
      name: `${rule.name} on ${resource.name}`,
      severity: rule.severity,
      state: 'firing',
      value: result.value ?? 0,
      startedAt: at,
    });
  } else if (result.clear === true) {
    if (!incident.clearSince) {
      await store.update('alertIncident', incident.id, { clearSince: at, value: result.value ?? incident.value });
    } else if (now - new Date(incident.clearSince).getTime() >= RECOVERY_MS) {
      const resolved = await store.update('alertIncident', incident.id, {
        state: 'resolved',
        resolvedAt: at,
        value: result.value ?? incident.value,
      });
      if (incident.notified) await enqueueNotifications(store, resolved, { rule, recovery: true, now });
    }
    return;
  } else if (result.clear === false || result.fire === true) {
    // Still (or again) a problem: cancel any recovery in progress.
    await store.update('alertIncident', incident.id, {
      value: result.value ?? incident.value,
      ...(incident.clearSince ? { clearSince: null } : {}),
    });
  } else return;

  if (result.fire !== true || incident.notified || silenced) return;
  // Cooldown: a repeat of the same problem shortly after an alert stays quiet.
  const recent = await store.client.alertIncident.findFirst({
    where: {
      ruleId: rule.id,
      resourceId: resource.id,
      id: { not: incident.id },
      lastNotifiedAt: { gt: new Date(now - rule.cooldownSeconds * 1000) },
    },
  });
  if (recent) return;
  await enqueueNotifications(store, incident, { rule, detail: result.detail, now });
  await store.update('alertIncident', incident.id, { notified: true, lastNotifiedAt: at });
}
