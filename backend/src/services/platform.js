import { config } from '../config.js';
import { assert } from '../lib/errors.js';
import { planLimit } from './limits.js';
import { downgradeProblems } from './billing.js';
import * as agentConfig from './agent-config.js';
import { readUsage, quotaBytes } from './otel-usage.js';
import { forgetSuspendedOrgs } from './platform-suspension.js';
import { QUEUE_NAMES } from '../routes/metrics-internal.js';
import { getQueue } from '../queues/factory.js';
import { ingestPressure } from '../queues/ingest-queues.js';

/**
 * The Yukti platform admin (staff-only, /api/platform). Read helpers for the overview, organizations,
 * users and audit pages, and the writes (plan, suspension, user access). Every write records a
 * PlatformAuditLog row in the same transaction as the change.
 */

const DAY = 86400000;
export const PAGE_SIZE = 25;
const PAID_STATUSES = ['active', 'past_due', 'trialing'];
const ACTIVE_AGENT_MS = 10 * 60000; // an agent seen in the last 10 minutes counts as active

export const page = ({ page = 1, pageSize = PAGE_SIZE } = {}) => ({
  skip: (page - 1) * pageSize,
  take: pageSize,
});

export function platformAudit(store, admin, action, targetType, targetId, details = {}) {
  return store.create('platformAuditLog', {
    adminUserId: admin.id,
    action,
    targetType,
    targetId,
    details,
  });
}

// ---------------------------------------------------------------- overview

/** Monthly value of one subscription in USD cents: plan price (annual = 10 months / 12) plus extra servers. */
export function monthlyCents(subscription, plan, servers = 0) {
  if (!plan || plan.priceUsdCents <= 0) return 0;
  const extra = Math.max(0, servers - plan.includedServers) * plan.extraServerUsdCents;
  const base =
    subscription.interval === 'annual'
      ? Math.round((plan.priceUsdCents * 10) / 12)
      : plan.priceUsdCents;
  return base + extra;
}

async function serverCounts(store, orgIds) {
  if (!orgIds.length) return new Map();
  const rows = await store.client.monitoredResource.groupBy({
    by: ['orgId'],
    where: { orgId: { in: orgIds }, type: 'server', deletedAt: null },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.orgId, r._count._all]));
}

/** VictoriaMetrics active series (null when it is not reachable; the overview still renders). */
async function vmSeries() {
  try {
    const response = await fetch(
      `${config.VM_URL || 'http://localhost:8428'}/api/v1/series/count`,
      {
        signal: AbortSignal.timeout(2000),
      },
    );
    if (!response.ok) return null;
    const body = await response.json();
    const value = Number(Array.isArray(body?.data) ? body.data[0] : body?.data);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** Queue depth and ingest lag (the same sources as /metrics). Never throws. */
async function health(now = Date.now()) {
  const queues = [];
  let error = null;
  try {
    for (const name of QUEUE_NAMES) {
      const counts = await getQueue(name).getJobCounts('waiting', 'active', 'delayed', 'failed');
      queues.push({
        name,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
      });
    }
  } catch (cause) {
    error = `Queues unavailable: ${cause.message}`;
  }
  let ingestLagSeconds = null;
  try {
    ingestLagSeconds = (await ingestPressure(now)).lagMs / 1000;
  } catch {
    /* reported through `error` above when Redis is down */
  }
  return { queues, ingestLagSeconds, vmSeries: await vmSeries(), error };
}

export async function overview(store, now = Date.now()) {
  const db = store.client;
  const since = new Date(now - 29 * DAY);
  since.setUTCHours(0, 0, 0, 0);
  const [orgs, suspended, users, activeAgents, monitors, byPlan, subscriptions, plans, signups] =
    await Promise.all([
      db.organization.count(),
      db.organization.count({ where: { suspendedAt: { not: null } } }),
      db.user.count(),
      db.agent.count({
        where: { status: { not: 'revoked' }, lastSeen: { gt: new Date(now - ACTIVE_AGENT_MS) } },
      }),
      db.uptimeMonitor.count(),
      db.subscription.groupBy({ by: ['planId'], _count: { _all: true } }),
      db.subscription.findMany({
        where: { status: { in: PAID_STATUSES }, planId: { not: 'free' } },
        select: { orgId: true, planId: true, interval: true, provider: true },
      }),
      db.subscriptionPlan.findMany(),
      db.organization.findMany({
        where: { createdAt: { gte: since } },
        select: { createdAt: true },
      }),
    ]);
  const planById = new Map(plans.map((p) => [p.id, p]));
  const servers = await serverCounts(
    store,
    subscriptions.map((s) => s.orgId),
  );
  // MRR counts subscriptions billed by a payment provider; provider-less paid plans (comped by staff,
  // or the dev mock provider) are reported separately so they never inflate revenue.
  let mrrCents = 0;
  let compedCents = 0;
  let comped = 0;
  const mrrByPlan = {};
  for (const s of subscriptions) {
    const cents = monthlyCents(s, planById.get(s.planId), servers.get(s.orgId) ?? 0);
    if (s.provider) {
      mrrCents += cents;
      mrrByPlan[s.planId] = (mrrByPlan[s.planId] ?? 0) + cents;
    } else {
      compedCents += cents;
      comped++;
    }
  }
  const days = new Map();
  for (let i = 0; i < 30; i++)
    days.set(new Date(since.getTime() + i * DAY).toISOString().slice(0, 10), 0);
  for (const { createdAt } of signups) {
    const key = createdAt.toISOString().slice(0, 10);
    if (days.has(key)) days.set(key, days.get(key) + 1);
  }
  const order = plans.sort((a, b) => a.priceUsdCents - b.priceUsdCents).map((p) => p.id);
  const counts = new Map(byPlan.map((r) => [r.planId, r._count._all]));
  return {
    totals: { orgs, suspended, users, activeAgents, monitors },
    orgsByPlan: order.map((planId) => ({
      planId,
      name: planById.get(planId)?.name ?? planId,
      count: counts.get(planId) ?? 0,
    })),
    mrrCents,
    mrrByPlan: order.map((planId) => ({ planId, cents: mrrByPlan[planId] ?? 0 })),
    compedCents,
    comped,
    signupsByDay: [...days].map(([day, count]) => ({ day, count })),
    health: await health(now),
  };
}

// ---------------------------------------------------------------- organizations

function orgWhere({ q, plan, status }) {
  const where = {};
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { slug: { contains: q, mode: 'insensitive' } },
      { id: q },
      { members: { some: { user: { email: { contains: q, mode: 'insensitive' } } } } },
    ];
  }
  if (plan) where.subscription = { planId: plan };
  if (status === 'suspended') where.suspendedAt = { not: null };
  if (status === 'active') where.suspendedAt = null;
  return where;
}

export async function listOrgs(store, filters) {
  const where = orgWhere(filters);
  const [total, rows] = await Promise.all([
    store.client.organization.count({ where }),
    store.client.organization.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...page(filters),
      include: {
        subscription: { select: { planId: true, status: true, periodEnd: true, provider: true } },
        _count: { select: { members: true } },
        members: {
          where: { role: 'owner' },
          take: 1,
          include: { user: { select: { email: true, name: true } } },
        },
      },
    }),
  ]);
  const servers = await serverCounts(
    store,
    rows.map((r) => r.id),
  );
  return {
    total,
    items: rows.map((o) => ({
      id: o.id,
      name: o.name,
      slug: o.slug,
      createdAt: o.createdAt,
      suspendedAt: o.suspendedAt,
      suspendReason: o.suspendReason,
      planId: o.subscription?.planId ?? null,
      subscriptionStatus: o.subscription?.status ?? null,
      periodEnd: o.subscription?.periodEnd ?? null,
      provider: o.subscription?.provider ?? null,
      members: o._count.members,
      servers: servers.get(o.id) ?? 0,
      owner: o.members[0]?.user ?? null,
    })),
  };
}

async function requireOrg(store, id) {
  const org = await store.find('organization', { id });
  assert(org, 404, 'Organization not found.');
  return org;
}

export async function orgDetail(store, id) {
  const db = store.client;
  const org = await requireOrg(store, id);
  const [members, subscription, invoices, agents, monitors, alertRules, audit, platformLog, plans] =
    await Promise.all([
      db.organizationMember.findMany({
        where: { orgId: id },
        orderBy: { createdAt: 'asc' },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              disabledAt: true,
              isPlatformAdmin: true,
              emailVerifiedAt: true,
            },
          },
        },
      }),
      db.subscription.findFirst({ where: { orgId: id }, include: { plan: true } }),
      db.invoice.findMany({ where: { orgId: id }, orderBy: { createdAt: 'desc' }, take: 25 }),
      db.agent.findMany({
        where: { orgId: id },
        orderBy: { lastSeen: 'desc' },
        take: 200,
        select: {
          id: true,
          name: true,
          status: true,
          lastSeen: true,
          version: true,
          os: true,
          arch: true,
          kind: true,
          platform: true,
          createdAt: true,
        },
      }),
      db.uptimeMonitor.findMany({
        where: { orgId: id },
        orderBy: { createdAt: 'asc' },
        take: 200,
        select: {
          id: true,
          name: true,
          target: true,
          type: true,
          status: true,
          enabled: true,
          intervalSeconds: true,
          lastCheckedAt: true,
        },
      }),
      db.alertRule.count({ where: { orgId: id, deletedAt: null } }),
      db.auditLog.findMany({
        where: { orgId: id },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { user: { select: { email: true } } },
      }),
      db.platformAuditLog.findMany({
        where: { targetType: 'organization', targetId: id },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { admin: { select: { email: true } } },
      }),
      db.subscriptionPlan.findMany({ orderBy: { priceUsdCents: 'asc' } }),
    ]);
  const servers = (await serverCounts(store, [id])).get(id) ?? 0;
  const plan = subscription?.plan ?? null;
  let telemetry = null;
  try {
    telemetry = { ...(await readUsage(id)), quotaBytes: quotaBytes(plan?.id) };
  } catch {
    /* Redis unavailable: the page shows "unknown" */
  }
  const limit = (key, fallback) => {
    const value = plan ? (key === 'servers' ? planLimit(plan, 'servers') : plan[fallback]) : null;
    return Number.isFinite(value) ? value : null; // null = unlimited (paid plans can add servers)
  };
  return {
    organization: org,
    members: members.map((m) => ({ id: m.id, role: m.role, createdAt: m.createdAt, user: m.user })),
    subscription: subscription && { ...subscription, plan: undefined },
    plan,
    monthlyCents: subscription ? monthlyCents(subscription, plan, servers) : 0,
    invoices,
    agents,
    monitors,
    usage: {
      servers: { used: servers, limit: limit('servers') },
      monitors: { used: monitors.length, limit: limit('monitors', 'monitors') },
      members: { used: members.length, limit: limit('members', 'members') },
      alertRules: { used: alertRules, limit: limit('alertRules', 'alertRules') },
      telemetry,
    },
    audit: audit.map(({ user, ...row }) => ({ ...row, userEmail: user?.email ?? null })),
    platformAudit: platformLog.map(({ admin, ...row }) => ({
      ...row,
      adminEmail: admin?.email ?? null,
    })),
    // For the Change plan dialog.
    plans: plans.map((p) => ({
      id: p.id,
      name: p.name,
      priceUsdCents: p.priceUsdCents,
      includedServers: p.includedServers,
    })),
  };
}

/** Agents follow the new plan (Prometheus collector on/off). Never fails the admin's change. */
async function notifyPlanChanged(store, orgId) {
  if (typeof agentConfig.onPlanChanged !== 'function')
    return { skipped: 'onPlanChanged is not available' };
  try {
    return await agentConfig.onPlanChanged(store, orgId);
  } catch (error) {
    console.error(
      `[platform] agent settings update after plan change failed for ${orgId}: ${error.message}`,
    );
    return { error: error.message };
  }
}

/**
 * Change, comp or extend an organization's plan. Staff overrides skip the provider: the subscription
 * row is set directly (status active, period end given or 30 days for paid plans). A provider-billed
 * subscription keeps its provider ids, so a later provider event can still update it.
 */
export async function changePlan(store, admin, orgId, { planId, periodEnd, note }) {
  await requireOrg(store, orgId);
  const plan = await store.find('subscriptionPlan', { id: planId });
  assert(plan, 400, 'Unknown plan.');
  if (periodEnd)
    assert(
      new Date(periodEnd).getTime() > Date.now(),
      400,
      'The period end must be in the future.',
    );
  const result = await store.transaction(async (tx) => {
    const current = await tx.find('subscription', { orgId });
    const end = periodEnd
      ? new Date(periodEnd)
      : plan.id === 'free'
        ? new Date(Date.now() + 3650 * DAY)
        : current && current.planId === plan.id && new Date(current.periodEnd) > new Date()
          ? new Date(current.periodEnd)
          : new Date(Date.now() + 30 * DAY);
    const fields = {
      planId: plan.id,
      status: 'active',
      periodEnd: end,
      cancelAtPeriodEnd: false,
      pastDueSince: null,
    };
    const subscription = current
      ? await tx.update('subscription', current.id, fields)
      : await tx.create('subscription', { orgId, interval: 'monthly', ...fields });
    const action = current?.planId === plan.id ? 'org.plan_extended' : 'org.plan_changed';
    await platformAudit(tx, admin, action, 'organization', orgId, {
      from: current?.planId ?? null,
      to: plan.id,
      previousPeriodEnd: current?.periodEnd ?? null,
      periodEnd: end,
      provider: current?.provider ?? null,
      ...(note ? { note } : {}),
    });
    return { subscription, action };
  });
  const agents = await notifyPlanChanged(store, orgId);
  // Staff may put an org above the new plan's limits; say so instead of refusing.
  const warnings = (await downgradeProblems(store, orgId, plan)).map(
    (p) => `${p.used} ${p.label} (the ${plan.name} plan allows ${p.limit})`,
  );
  return { ...result, plan, agents, warnings };
}

export async function suspendOrg(store, admin, orgId, reason) {
  const org = await requireOrg(store, orgId);
  assert(!org.suspendedAt, 409, 'This organization is already suspended.');
  const updated = await store.transaction(async (tx) => {
    const row = await tx.update('organization', orgId, {
      suspendedAt: new Date(),
      suspendReason: reason,
    });
    await platformAudit(tx, admin, 'org.suspended', 'organization', orgId, {
      reason,
      name: org.name,
    });
    return row;
  });
  forgetSuspendedOrgs();
  return updated;
}

export async function reactivateOrg(store, admin, orgId, note) {
  const org = await requireOrg(store, orgId);
  assert(org.suspendedAt, 409, 'This organization is not suspended.');
  const updated = await store.transaction(async (tx) => {
    const row = await tx.update('organization', orgId, { suspendedAt: null, suspendReason: null });
    await platformAudit(tx, admin, 'org.reactivated', 'organization', orgId, {
      name: org.name,
      suspendedAt: org.suspendedAt,
      reason: org.suspendReason,
      ...(note ? { note } : {}),
    });
    return row;
  });
  forgetSuspendedOrgs();
  return updated;
}

// ---------------------------------------------------------------- users

const publicAdminUser = (u, lastActive) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  emailVerified: Boolean(u.emailVerifiedAt),
  isPlatformAdmin: u.isPlatformAdmin,
  disabledAt: u.disabledAt,
  createdAt: u.createdAt,
  lastActiveAt: lastActive ?? null,
  organizations: (u.memberships ?? []).map((m) => ({
    id: m.orgId,
    name: m.organization?.name,
    role: m.role,
    suspendedAt: m.organization?.suspendedAt ?? null,
  })),
});

export async function listUsers(store, filters) {
  const where = {};
  if (filters.q)
    where.OR = [
      { email: { contains: filters.q, mode: 'insensitive' } },
      { name: { contains: filters.q, mode: 'insensitive' } },
      { id: filters.q },
    ];
  if (filters.status === 'disabled') where.disabledAt = { not: null };
  if (filters.status === 'active') where.disabledAt = null;
  if (filters.status === 'staff') where.isPlatformAdmin = true;
  const [total, rows] = await Promise.all([
    store.client.user.count({ where }),
    store.client.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...page(filters),
      include: {
        memberships: { include: { organization: { select: { name: true, suspendedAt: true } } } },
      },
    }),
  ]);
  const last = rows.length
    ? await store.client.session.groupBy({
        by: ['userId'],
        where: { userId: { in: rows.map((u) => u.id) } },
        _max: { lastUsedAt: true },
      })
    : [];
  const lastBy = new Map(last.map((r) => [r.userId, r._max.lastUsedAt]));
  return { total, items: rows.map((u) => publicAdminUser(u, lastBy.get(u.id))) };
}

async function requireUser(store, id) {
  const user = await store.find('user', { id });
  assert(user, 404, 'User not found.');
  return user;
}

/** Disable a user: no new sign-ins (login answers 403) and every open session is revoked now. */
export async function disableUser(store, admin, userId, reason) {
  const user = await requireUser(store, userId);
  assert(user.id !== admin.id, 400, 'You cannot disable your own account.');
  assert(!user.disabledAt, 409, 'This user is already disabled.');
  return store.transaction(async (tx) => {
    const now = new Date();
    const row = await tx.update('user', userId, { disabledAt: now });
    const revoked = await tx.updateMany('session', { userId, revokedAt: null }, { revokedAt: now });
    await platformAudit(tx, admin, 'user.disabled', 'user', userId, {
      email: user.email,
      sessionsRevoked: revoked,
      ...(reason ? { reason } : {}),
    });
    return publicAdminUser(row);
  });
}

export async function enableUser(store, admin, userId) {
  const user = await requireUser(store, userId);
  assert(user.disabledAt, 409, 'This user is not disabled.');
  return store.transaction(async (tx) => {
    const row = await tx.update('user', userId, { disabledAt: null });
    await platformAudit(tx, admin, 'user.enabled', 'user', userId, {
      email: user.email,
      disabledAt: user.disabledAt,
    });
    return publicAdminUser(row);
  });
}

// ---------------------------------------------------------------- audit

export async function listAudit(store, filters) {
  const where = {};
  if (filters.targetType) where.targetType = filters.targetType;
  if (filters.targetId) where.targetId = filters.targetId;
  if (filters.action) where.action = filters.action;
  const [total, rows] = await Promise.all([
    store.client.platformAuditLog.count({ where }),
    store.client.platformAuditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...page(filters),
      include: { admin: { select: { email: true, name: true } } },
    }),
  ]);
  // Show a readable name for each target (organization name or user email).
  const ids = (type) => [
    ...new Set(rows.filter((r) => r.targetType === type).map((r) => r.targetId)),
  ];
  const [orgs, users] = await Promise.all([
    store.client.organization.findMany({
      where: { id: { in: ids('organization') } },
      select: { id: true, name: true },
    }),
    store.client.user.findMany({
      where: { id: { in: ids('user') } },
      select: { id: true, email: true },
    }),
  ]);
  const label = new Map([...orgs.map((o) => [o.id, o.name]), ...users.map((u) => [u.id, u.email])]);
  return {
    total,
    items: rows.map(({ admin, ...row }) => ({
      ...row,
      adminEmail: admin?.email ?? null,
      adminName: admin?.name ?? null,
      targetLabel: label.get(row.targetId) ?? null,
    })),
  };
}
