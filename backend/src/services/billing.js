import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { assert } from '../lib/errors.js';

// Adapters implement changeSubscription; the mock never charges a real payment method.
// Razorpay (INR) and Stripe (USD) adapters arrive in the billing phase.
export const billingProvider = {
  name: 'mock',
  async changeSubscription(store, orgId, plan, interval) {
    const subscription = await store.find('subscription', { orgId });
    const periodEnd = new Date(Date.now() + (interval === 'annual' ? 365 : 30) * 86400000);
    await store.update('subscription', subscription.id, {
      planId: plan.id,
      status: 'active',
      interval,
      periodEnd,
      cancelAtPeriodEnd: false,
    });
    return store.create('invoice', {
      orgId,
      number: `MOCK-${Date.now()}`,
      amount: plan.priceUsdCents * (interval === 'annual' ? 10 : 1),
      currency: 'USD',
      status: 'simulated',
      provider: 'mock',
      periodStart: new Date(),
      periodEnd,
    });
  },
};
export function verifyWebhook(body, signature) {
  const expected = createHmac('sha256', config.BILLING_WEBHOOK_SECRET).update(body).digest();
  const supplied = Buffer.from(signature || '', 'hex');
  assert(
    supplied.length === expected.length && timingSafeEqual(expected, supplied),
    401,
    'Invalid webhook signature.',
  );
}
export async function processWebhook(store, event) {
  return store.transaction(async (tx) => {
    if (await tx.find('webhookEvent', { id: event.id })) return { duplicate: true };
    const subscription = await tx.find('subscription', { orgId: event.orgId });
    assert(subscription, 404, 'Subscription not found.');
    const states = {
      'payment.succeeded': 'active',
      'payment.failed': 'past_due',
      'subscription.cancelled': 'cancelled',
    };
    assert(states[event.type], 400, 'Unsupported event type.');
    await tx.create('webhookEvent', {
      id: event.id,
      orgId: event.orgId,
      type: event.type,
      payload: event,
    });
    await tx.update('subscription', subscription.id, { status: states[event.type] });
    await tx.create('payment', {
      orgId: event.orgId,
      providerId: event.id,
      provider: 'mock',
      amount: event.amount || 0,
      currency: event.currency || 'USD',
      status: event.type === 'payment.succeeded' ? 'succeeded' : 'failed',
    });
    return { duplicate: false };
  });
}
