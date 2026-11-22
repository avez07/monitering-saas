import { assert, HttpError } from '../lib/errors.js';
import { planLimit } from './limits.js';
import { sendMail } from './mail.js';
import { computeGst } from './billing-tax.js';
import { getProviders } from './billing-providers/index.js';
import { onPlanChanged } from './agent-config.js';

export const GRACE_DAYS = 7;
const DAY = 86400000;

/** Dev-only provider behind /api/billing/change (BILLING_DEV_MODE). It never charges anything. */
export const billingProvider = {
  name: 'mock',
  async changeSubscription(store, orgId, plan, interval, currency = 'INR') {
    const subscription = await store.find('subscription', { orgId });
    const periodEnd = new Date(Date.now() + (interval === 'annual' ? 365 : 30) * DAY);
    await store.update('subscription', subscription.id, {
      planId: plan.id,
      status: 'active',
      interval,
      periodEnd,
      cancelAtPeriodEnd: false,
      pastDueSince: null,
    });
    const mult = interval === 'annual' ? 10 : 1;
    const base = { orgId, number: `MOCK-${Date.now()}`, status: 'simulated', provider: 'mock', periodStart: new Date(), periodEnd };
    if (currency === 'USD') return store.create('invoice', { ...base, amount: plan.priceUsdCents * mult, currency: 'USD' });
    // INR is the default: 18% GST on top, split into CGST+SGST or IGST by the customer's state.
    const profile = await store.find('billingProfile', { orgId });
    const gst = computeGst(plan.priceInrPaise * mult, profile || {});
    return store.create('invoice', {
      ...base,
      amount: gst.total,
      currency: 'INR',
      subtotal: gst.subtotal,
      tax: gst.tax,
      taxRate: gst.rate,
      taxBreakdown: gst.breakdown,
      customerGstin: profile?.gstin || null,
    });
  },
};

/**
 * After a committed plan change: agents follow the new plan's features (Prometheus collector on or off).
 * Never fails the billing operation; the prom write endpoint also refuses unentitled orgs.
 */
export async function planChanged(db, orgId) {
  if (!orgId) return;
  try {
    await onPlanChanged(db, orgId);
  } catch (error) {
    console.error(`[billing] agent settings update after plan change failed for ${orgId}: ${error.message}`);
  }
}

// ---------------------------------------------------------------- limit checks

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Compare current usage with a plan's limits; returns plain-language problems (empty = fine). */
export async function downgradeProblems(store, orgId, plan) {
  const count = async (table, where = {}) => (await store.list(table, { orgId, ...where })).length;
  const servers = (await store.list('monitoredResource', { orgId, type: 'server' })).filter(
    (r) => !r.deletedAt,
  ).length;
  const checks = [
    ['servers', servers, planLimit(plan, 'servers'), 'server'],
    ['website checks', await count('uptimeMonitor'), plan.monitors, 'website check'],
    ['team members', await count('organizationMember'), plan.members, 'team member'],
    [
      'alert rules',
      (await store.list('alertRule', { orgId })).filter((r) => !r.deletedAt).length,
      plan.alertRules,
      'alert rule',
    ],
  ];
  return checks
    .filter(([, used, limit]) => used > limit)
    .map(([label, used, limit, one]) => ({ label, used, limit, remove: used - limit, one }));
}
export function assertCanSwitch(problems, plan) {
  if (!problems.length) return;
  const details = problems.map((p) => `${p.used} ${p.label} (the ${plan.name} plan allows ${p.limit})`);
  const remove = problems.map((p) => plural(p.remove, p.one));
  const error = new HttpError(
    400,
    `Your account is above the ${plan.name} plan limits: ${details.join(', ')}. Remove ${remove.join(', ')} before switching.`,
  );
  error.reason = 'plan_limits_exceeded';
  throw error;
}

// ---------------------------------------------------------------- webhook processing

async function ownerEmail(store, orgId) {
  const owner = await store.find('organizationMember', { orgId, role: 'owner' });
  const user = owner && (await store.find('user', { id: owner.userId }));
  return user ? { email: user.email, name: user.name } : null;
}
async function mailOwner(store, orgId, subject, lines) {
  const owner = await ownerEmail(store, orgId).catch(() => null);
  if (owner) await sendMail({ to: owner.email, subject, text: [`Hi ${owner.name},`, '', ...lines].join('\n') });
}

async function resolveOrg(tx, event) {
  if (event.orgId && (await tx.find('organization', { id: event.orgId }))) return event.orgId;
  if (event.subscriptionId) {
    const row = await tx.find('subscription', { providerSubscriptionId: event.subscriptionId });
    if (row) return row.orgId;
  }
  if (event.customerId) {
    const customer = await tx.find('billingCustomer', { providerId: event.customerId });
    if (customer) return customer.orgId;
  }
  return null;
}

const isOlder = (subscription, event) =>
  subscription.providerEventAt && new Date(event.createdAt) < new Date(subscription.providerEventAt);
const newer = (subscription, event) =>
  !subscription.providerEventAt || new Date(event.createdAt) > new Date(subscription.providerEventAt)
    ? new Date(event.createdAt)
    : subscription.providerEventAt;

/** True when this provider subscription is (or can become) the organization's current one. */
const ownsSubscription = (subscription, event) =>
  !event.subscriptionId ||
  !subscription.providerSubscriptionId ||
  subscription.providerSubscriptionId === event.subscriptionId;

async function activate(tx, subscription, event, plan) {
  if (isOlder(subscription, event) || !ownsSubscription(subscription, event)) return;
  const interval = ['monthly', 'annual'].includes(event.interval) ? event.interval : subscription.interval;
  await tx.update('subscription', subscription.id, {
    planId: plan.id,
    status: event.status === 'past_due' ? 'past_due' : 'active',
    interval,
    // Checkout events carry no period; use a provisional one until the subscription event sets the real end.
    periodEnd: event.periodEnd || new Date(Date.now() + (interval === 'annual' ? 366 : 32) * DAY),
    cancelAtPeriodEnd: event.cancelAtPeriodEnd ?? false,
    provider: event.provider,
    providerSubscriptionId: event.subscriptionId || subscription.providerSubscriptionId,
    currency: event.currency || subscription.currency,
    ...(event.status === 'past_due' ? {} : { pastDueSince: null }),
    providerEventAt: newer(subscription, event),
  });
}

async function saveCustomer(tx, orgId, event) {
  if (!event.customerId) return;
  const existing = await tx.find('billingCustomer', { orgId });
  if (existing) {
    if (existing.providerId !== event.customerId)
      await tx.update('billingCustomer', existing.id, {
        provider: event.provider,
        providerId: event.customerId,
      });
  } else
    await tx.create('billingCustomer', { orgId, provider: event.provider, providerId: event.customerId });
}

export async function downgradeToFree(tx, subscription, event = {}) {
  await tx.update('subscription', subscription.id, {
    planId: 'free',
    status: 'active',
    interval: 'monthly',
    periodEnd: new Date(Date.now() + 3650 * DAY),
    cancelAtPeriodEnd: false,
    provider: null,
    providerSubscriptionId: null,
    currency: null,
    pastDueSince: null,
    ...(event.createdAt ? { providerEventAt: newer(subscription, event) } : {}),
  });
}

/** Apply one normalized provider event inside the caller's transaction. Returns side effects to run after commit. */
async function applyRefund(tx, event) {
  let payment = null;
  for (const id of event.refund.paymentIds) payment ||= await tx.find('payment', { providerId: id });
  if (!payment) return { orgId: null }; // not one of our subscription payments
  const refunded =
    event.refund.totalRefunded !== undefined
      ? event.refund.totalRefunded
      : payment.refundedAmount + (event.refund.amount || 0);
  await tx.update('payment', payment.id, {
    refundedAmount: Math.min(refunded, payment.amount),
    status: refunded >= payment.amount ? 'refunded' : 'partially_refunded',
  });
  return { orgId: payment.orgId };
}

async function applyEvent(tx, db, event, after) {
  if (event.type === 'refund.created') return applyRefund(tx, event);
  const orgId = await resolveOrg(tx, event);
  if (!orgId) {
    // Probably arrived before the checkout event that links the organization; let the provider retry.
    throw new HttpError(409, 'Organization not found for this event yet.');
  }
  const subscription = await tx.find('subscription', { orgId });
  assert(subscription, 404, 'Subscription not found.');
  const plan = event.planId && (await tx.find('subscriptionPlan', { id: event.planId }));
  const handled = { orgId };
  switch (event.type) {
    case 'checkout.completed':
      await saveCustomer(tx, orgId, event);
      if (plan && plan.id !== 'free') await activate(tx, subscription, event, plan);
      break;
    case 'subscription.updated': {
      await saveCustomer(tx, orgId, event);
      if (isOlder(subscription, event) || !ownsSubscription(subscription, event)) break;
      if (event.status === 'cancelled') {
        await downgradeToFree(tx, subscription, event);
      } else if (plan && plan.id !== 'free') {
        await activate(tx, subscription, event, plan);
      } else {
        await tx.update('subscription', subscription.id, {
          ...(event.status ? { status: event.status } : {}),
          ...(event.periodEnd ? { periodEnd: event.periodEnd } : {}),
          ...(event.cancelAtPeriodEnd !== undefined ? { cancelAtPeriodEnd: event.cancelAtPeriodEnd } : {}),
          ...(event.status === 'active' ? { pastDueSince: null } : {}),
          ...(event.status === 'past_due' && !subscription.pastDueSince ? { pastDueSince: new Date() } : {}),
          providerEventAt: newer(subscription, event),
        });
      }
      break;
    }
    case 'subscription.cancelled':
      if (!isOlder(subscription, event) && ownsSubscription(subscription, event) && subscription.providerSubscriptionId)
        await downgradeToFree(tx, subscription, event);
      break;
    case 'invoice.paid': {
      const i = event.invoice;
      if (!(await tx.find('invoice', { number: i.number }))) {
        const profile = await tx.find('billingProfile', { orgId });
        const split = i.currency === 'INR' ? computeGst(i.subtotal, profile || {}) : null;
        await tx.create('invoice', {
          orgId,
          number: i.number,
          amount: i.total,
          subtotal: i.subtotal,
          tax: i.tax,
          taxRate: i.subtotal ? Math.round((i.tax / i.subtotal) * 10000) / 10000 : 0,
          taxBreakdown: split?.breakdown,
          customerGstin: profile?.gstin || null,
          currency: i.currency,
          status: 'paid',
          provider: event.provider,
          periodStart: i.periodStart || new Date(event.createdAt),
          periodEnd: i.periodEnd || new Date(event.createdAt),
          url: i.url || null,
        });
      }
      if (i.paymentId && !(await tx.find('payment', { providerId: i.paymentId })))
        await tx.create('payment', {
          orgId,
          providerId: i.paymentId,
          provider: event.provider,
          amount: i.total,
          currency: i.currency,
          status: 'succeeded',
        });
      // A successful charge on the current subscription ends dunning (unless a newer failure already won).
      if (
        subscription.status === 'past_due' &&
        ownsSubscription(subscription, event) &&
        !isOlder(subscription, event)
      )
        await tx.update('subscription', subscription.id, {
          status: 'active',
          pastDueSince: null,
          providerEventAt: newer(subscription, event),
        });
      break;
    }
    case 'invoice.failed': {
      const i = event.invoice || {};
      await tx.create('payment', {
        orgId,
        providerId: `${event.provider}:failed:${event.eventId}`,
        provider: event.provider,
        amount: i.total || 0,
        currency: i.currency || subscription.currency || 'USD',
        status: 'failed',
      });
      if (
        subscription.planId !== 'free' &&
        ownsSubscription(subscription, event) &&
        !isOlder(subscription, event)
      ) {
        await tx.update('subscription', subscription.id, {
          status: 'past_due',
          pastDueSince: subscription.pastDueSince || new Date(),
          providerEventAt: newer(subscription, event),
        });
        after.push(() =>
          mailOwner(db, orgId, 'Your YuktiOps payment failed', [
            'We could not charge your payment method for your YuktiOps subscription.',
            `Please update your payment details within ${GRACE_DAYS} days. After that your account moves to the Free plan.`,
          ]),
        );
      }
      break;
    }
    default:
      break;
  }
  return handled;
}

/**
 * Verified, normalized provider event -> state. Idempotent: the (provider, eventId) pair is stored in the
 * same transaction as the effects, so a replay changes nothing and a failed attempt can be retried.
 */
export async function processProviderEvent(db, event) {
  if (event.type === 'ignored') return { duplicate: false, ignored: true };
  const key = `${event.provider}:${event.eventId}`;
  const after = [];
  try {
    const result = await db.transaction(async (tx) => {
      if (await tx.find('webhookEvent', { provider: event.provider, eventId: event.eventId }))
        return { duplicate: true };
      const { orgId } = await applyEvent(tx, db, event, after);
      // Any subscription event may change the plan or its validity; agents re-check their features.
      if (orgId && event.type !== 'refund.created') after.push(() => planChanged(db, orgId));
      await tx.create('webhookEvent', {
        id: key,
        orgId,
        provider: event.provider,
        eventId: event.eventId,
        type: event.type,
        payload: { type: event.type, createdAt: event.createdAt, subscriptionId: event.subscriptionId || null },
      });
      return { duplicate: false };
    });
    for (const run of after) await run();
    return result;
  } catch (error) {
    // A concurrent delivery of the same event won the race: treat as a replay.
    if (error.code === 'P2002' || error.code === 'P2034')
      if (await db.find('webhookEvent', { provider: event.provider, eventId: event.eventId }))
        return { duplicate: true };
    throw error;
  }
}

// ---------------------------------------------------------------- dunning

/** Move subscriptions whose grace period has ended to Free. Run hourly by the worker. */
export async function runDunning(db, now = new Date()) {
  const cutoff = new Date(now.getTime() - GRACE_DAYS * DAY);
  const rows = await db.list('subscription', { status: 'past_due', pastDueSince: { lt: cutoff } });
  let downgraded = 0;
  for (const row of rows) {
    const provider = row.provider && getProviders()[row.provider];
    if (provider?.configured && row.providerSubscriptionId)
      await provider.cancelSubscription({ subscriptionId: row.providerSubscriptionId }).catch((e) =>
        console.error(`[billing] could not cancel ${row.providerSubscriptionId}: ${e.message}`),
      );
    await db.transaction((tx) => downgradeToFree(tx, row));
    downgraded++;
    await planChanged(db, row.orgId);
    await mailOwner(db, row.orgId, 'Your YuktiOps account moved to the Free plan', [
      `We could not collect payment for ${GRACE_DAYS} days, so your account is now on the Free plan.`,
      'Your data is kept. You can upgrade again any time from Plan & billing.',
    ]);
  }
  return downgraded;
}
