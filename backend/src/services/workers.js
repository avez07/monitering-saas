import nodemailer from 'nodemailer';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { checkTarget } from './uptime.js';
import { entitlements } from './limits.js';
import { trimRawMetricsByPlan } from './metrics.js';

export async function enqueueNotifications(store, incident, recovery = false) {
  const org = await store.find('organization', { id: incident.orgId });
  if (org.settings?.maintenanceUntil && new Date(org.settings.maintenanceUntil) > new Date())
    return;
  const channels = await store.list('notificationChannel', {
    orgId: incident.orgId,
    enabled: true,
  });
  for (const channel of channels)
    await store.create('notificationDelivery', {
      orgId: incident.orgId,
      incidentId: incident.id,
      channelId: channel.id,
      address: channel.address,
      subject: `[${recovery ? 'Recovered' : incident.severity}] ${incident.name}`,
      body: `${incident.name}\nState: ${incident.state}\nObserved value: ${incident.value}\nOpen ${config.APP_URL}/alerts`,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date().toISOString(),
    });
}
export async function evaluateAlerts(store, orgId) {
  const rules = await store.list('alertRule', { enabled: true, ...(orgId ? { orgId } : {}) });
  for (const rule of rules) {
    const resources = await store.list('monitoredResource', {
      orgId: rule.orgId,
      projectId: rule.projectId,
    });
    for (const resource of resources.filter((r) => !r.deletedAt)) {
      if (rule.metric !== 'availability' && resource.labels?.[rule.metric] == null) continue;
      const value =
        rule.metric === 'availability'
          ? resource.status === 'unhealthy' || resource.status === 'stopped'
            ? 0
            : 1
          : Number(resource.labels?.[rule.metric]);
      if (!Number.isFinite(value)) continue;
      const breached = rule.operator === 'lt' ? value < rule.threshold : value > rule.threshold;
      let incident = (
        await store.list('alertIncident', {
          orgId: rule.orgId,
          ruleId: rule.id,
          resourceId: resource.id,
        })
      ).find((i) => ['pending', 'firing', 'acknowledged'].includes(i.state));
      if (breached && !incident)
        incident = await store.create('alertIncident', {
          orgId: rule.orgId,
          projectId: rule.projectId,
          ruleId: rule.id,
          resourceId: resource.id,
          name: `${rule.name} on ${resource.name}`,
          severity: rule.severity,
          state: 'pending',
          value,
          startedAt: new Date().toISOString(),
        });
      if (!incident) continue;
      if (!breached) {
        const oldState = incident.state;
        incident = await store.update('alertIncident', incident.id, {
          state: 'resolved',
          resolvedAt: new Date().toISOString(),
          value,
        });
        if (oldState !== 'pending') await enqueueNotifications(store, incident, true);
      } else if (
        incident.state === 'pending' &&
        Date.now() - new Date(incident.startedAt).getTime() >= rule.durationSeconds * 1000
      ) {
        incident = await store.update('alertIncident', incident.id, { state: 'firing', value });
        const recent = (
          await store.list('alertIncident', {
            orgId: rule.orgId,
            ruleId: rule.id,
            resourceId: resource.id,
          })
        ).some(
          (i) =>
            i.id !== incident.id &&
            i.lastNotifiedAt &&
            Date.now() - new Date(i.lastNotifiedAt) < rule.cooldownSeconds * 1000,
        );
        if (!recent && (!rule.silenceUntil || new Date(rule.silenceUntil) < new Date())) {
          await enqueueNotifications(store, incident);
          await store.update('alertIncident', incident.id, {
            lastNotifiedAt: new Date().toISOString(),
          });
        }
      } else if (breached) await store.update('alertIncident', incident.id, { value });
    }
  }
}
export async function deliverNotifications(store, orgId) {
  const pending = await store.list('notificationDelivery', {
    status: 'pending',
    ...(orgId ? { orgId } : {}),
  });
  for (const delivery of pending.filter((d) => new Date(d.nextAttemptAt) <= new Date())) {
    try {
      if (config.EMAIL_PROVIDER === 'smtp') {
        const smtp = nodemailer.createTransport({
          host: config.SMTP_HOST,
          port: config.SMTP_PORT,
          secure: config.SMTP_PORT === 465,
          ...(config.SMTP_USER
            ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } }
            : {}),
        });
        await smtp.sendMail({
          from: config.EMAIL_FROM,
          to: delivery.address,
          subject: delivery.subject,
          text: delivery.body,
        });
      }
      await store.update('notificationDelivery', delivery.id, {
        status: config.EMAIL_PROVIDER === 'local' ? 'local' : 'delivered',
        attempts: delivery.attempts + 1,
        deliveredAt: new Date().toISOString(),
      });
    } catch (error) {
      const attempts = delivery.attempts + 1;
      await store.update('notificationDelivery', delivery.id, {
        attempts,
        status: attempts >= 5 ? 'failed' : 'pending',
        error: error.message.slice(0, 200),
        nextAttemptAt: new Date(
          Date.now() + Math.min(3600, 30 * 2 ** attempts) * 1000,
        ).toISOString(),
      });
    }
  }
}
export async function runChecks(store) {
  const monitors = await store.list('uptimeMonitor', { enabled: true });
  for (const monitor of monitors.filter(
    (m) => !m.nextCheckAt || new Date(m.nextCheckAt) <= new Date(),
  )) {
    const result = await checkTarget(monitor.target);
    const failures = result.ok ? 0 : (monitor.consecutiveFailures || 0) + 1;
    const status = result.ok
      ? 'healthy'
      : failures >= monitor.failureThreshold
        ? 'unhealthy'
        : 'pending';
    await store.create('uptimeCheck', { orgId: monitor.orgId, monitorId: monitor.id, ...result });
    await store.update('uptimeMonitor', monitor.id, {
      status,
      consecutiveFailures: failures,
      latencyMs: result.latencyMs,
      lastCheckedAt: new Date().toISOString(),
      nextCheckAt: new Date(Date.now() + monitor.intervalSeconds * 1000).toISOString(),
      certificateExpiresAt: result.certificateExpiresAt,
    });
    let resource = await store.find('monitoredResource', {
      orgId: monitor.orgId,
      externalId: monitor.id,
    });
    const values = {
      status,
      labels: {
        latency: result.latencyMs,
        availability: result.ok ? 1 : 0,
        certificateDays: result.certificateExpiresAt
          ? Math.floor((new Date(result.certificateExpiresAt) - Date.now()) / 86400000)
          : null,
      },
    };
    if (resource) await store.update('monitoredResource', resource.id, values);
    else
      await store.create('monitoredResource', {
        orgId: monitor.orgId,
        projectId: monitor.projectId,
        name: monitor.name,
        externalId: monitor.id,
        type: 'uptime',
        environment: 'production',
        ...values,
      });
  }
}
export async function housekeeping(store) {
  for (const agent of await store.list('agent')) {
    if (agent.status === 'revoked' || agent.status === 'offline') continue;
    if (Date.now() - new Date(agent.lastSeen) > 180000) {
      await store.update('agent', agent.id, { status: 'offline' });
      for (const r of await store.list('monitoredResource', { agentId: agent.id }))
        await store.update('monitoredResource', r.id, { status: 'unhealthy' });
    }
  }
  for (const org of await store.list('organization')) {
    let days = 7;
    try {
      days = (await entitlements(store, org.id)).plan.retentionDays;
    } catch {
      /* retain metadata after subscription expiry */
    }
    const createdAt = { lt: new Date(Date.now() - days * 86400000) };
    for (const table of ['uptimeCheck', 'notificationDelivery'])
      await store.removeMany(table, { orgId: org.id, createdAt });
  }
  // Expired sessions are useless; remove them in bulk.
  const now = new Date();
  await store.removeMany('session', {
    OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: new Date(Date.now() - 7 * 86400000) } }],
  });
  // Install steps from a machine that never registered, and old agent events, are only useful briefly.
  await store.removeMany('agentEvent', {
    agentId: null,
    createdAt: { lt: new Date(Date.now() - 7 * 86400000) },
  });
  await store.removeMany('agentEvent', { createdAt: { lt: new Date(Date.now() - 30 * 86400000) } });
  // Per-plan raw history limits only need checking occasionally.
  if (Date.now() - lastMetricTrim > 3600000) {
    lastMetricTrim = Date.now();
    await trimRawMetricsByPlan(store);
  }
}
let lastMetricTrim = 0;

export const LEASE_ID = 'main-worker';
export const LEASE_MS = 90000;
/**
 * Try to become the single active worker. The lease lives in Postgres, so two worker processes can
 * never run at once, and a crashed worker is replaced as soon as its lease expires.
 */
export async function acquireLease(store, holder, ttlMs = LEASE_MS) {
  const expiresAt = new Date(Date.now() + ttlMs);
  const row = await store.find('workerLease', { id: LEASE_ID });
  if (!row) {
    try {
      await store.create('workerLease', { id: LEASE_ID, holder, expiresAt });
      return true;
    } catch (error) {
      if (error.code === 'P2002') return false; // another worker created it first
      throw error;
    }
  }
  if (row.holder !== holder && row.expiresAt > new Date()) return false;
  // Atomically take over only if nobody changed the lease since we read it.
  return store.claim(
    'workerLease',
    LEASE_ID,
    { holder: row.holder, expiresAt: row.expiresAt },
    { holder, expiresAt },
  );
}
export async function releaseLease(store, holder) {
  await store.client?.workerLease.updateMany({
    where: { id: LEASE_ID, holder },
    data: { expiresAt: new Date(0) },
  });
}

/** One pass of background work. Returns false when another worker holds the lease. */
export async function runWorkerTick(store, holder) {
  if (!(await acquireLease(store, holder))) return false;
  for (const step of [runChecks, evaluateAlerts, deliverNotifications, housekeeping]) {
    await step(store);
    // A long step must not let the lease expire underneath us.
    if (!(await acquireLease(store, holder))) return false;
  }
  return true;
}
export function startWorkers(store) {
  const holder = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runWorkerTick(store, holder);
    } catch (error) {
      console.error('Worker:', error.message);
    } finally {
      running = false;
    }
  };
  tick();
  const timer = setInterval(tick, config.WORKER_INTERVAL_MS);
  return async () => {
    clearInterval(timer);
    await releaseLease(store, holder).catch(() => {});
  };
}
