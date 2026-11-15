import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { config } from '../src/config.js';
import { setup, closeStore, register, addMember } from './helpers.js';
import { outbox } from '../src/services/mail.js';
import { createStripe } from '../src/services/billing-providers/stripe.js';
import { createRazorpay } from '../src/services/billing-providers/razorpay.js';
import { setProviders } from '../src/services/billing-providers/index.js';
import { computeGst } from '../src/services/billing-tax.js';
import { runDunning } from '../src/services/billing.js';

const STRIPE_SECRET = 'whsec_test_secret';
const RZP_SECRET = 'rzp_webhook_secret';
const PRICE_MAP = {
  starter: { stripe: { monthly: 'price_s_m', annual: 'price_s_a' }, razorpay: { monthly: 'plan_s_m', annual: 'plan_s_a' } },
  pro: { stripe: { monthly: 'price_p_m', annual: 'price_p_a' }, razorpay: { monthly: 'plan_p_m', annual: 'plan_p_a' } },
};
const baseConfig = {
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: STRIPE_SECRET,
  RAZORPAY_KEY_ID: 'rzp_test_id',
  RAZORPAY_KEY_SECRET: 'rzp_secret',
  RAZORPAY_WEBHOOK_SECRET: RZP_SECRET,
  BILLING_PRICE_MAP: JSON.stringify(PRICE_MAP),
};

let app, store, calls, responder, clock;
const http = async (url, options) => {
  calls.push({ url, ...options });
  return responder(url, options);
};
function useProviders(overrides = {}) {
  const cfg = { ...baseConfig, ...overrides };
  setProviders({
    stripe: createStripe({ config: cfg, http, now: () => clock }),
    razorpay: createRazorpay({ config: cfg, http }),
  });
}
beforeEach(async () => {
  ({ app, store } = await setup());
  calls = [];
  clock = Date.now();
  responder = async () => ({ status: 200, json: {} });
  useProviders();
  config.BILLING_DEV_MODE = false;
});
after(async () => {
  setProviders(null);
  await closeStore();
});

// ---- helpers
const stripeSig = (body, ts = Math.floor(clock / 1000), secret = STRIPE_SECRET) =>
  `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
const postStripe = (event, { sig, ts } = {}) => {
  const body = typeof event === 'string' ? event : JSON.stringify(event);
  return request(app)
    .post('/api/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', sig ?? stripeSig(body, ts))
    .send(body);
};
let seq = 0;
const stripeEvent = (type, object, created = Math.floor(clock / 1000)) => ({
  id: `evt_${++seq}`,
  type,
  created,
  data: { object },
});
const postRazorpay = (event, id = `rzp_evt_${++seq}`, secret = RZP_SECRET) => {
  const body = JSON.stringify(event);
  return request(app)
    .post('/api/webhooks/razorpay')
    .set('Content-Type', 'application/json')
    .set('X-Razorpay-Event-Id', id)
    .set('X-Razorpay-Signature', createHmac('sha256', secret).update(body).digest('hex'))
    .send(body);
};
const sub = (owner) => store.find('subscription', { orgId: owner.orgId });
const checkoutDone = (owner, extra = {}, subId = 'sub_1', created) =>
  stripeEvent(
    'checkout.session.completed',
    {
      mode: 'subscription',
      client_reference_id: owner.orgId,
      customer: 'cus_1',
      subscription: subId,
      metadata: { orgId: owner.orgId, planId: 'starter', interval: 'monthly' },
      ...extra,
    },
    created,
  );
const invoiceObject = (subId = 'sub_1', extra = {}) => ({
  id: 'in_1',
  number: 'INV-0001',
  subscription: subId,
  customer: 'cus_1',
  amount_paid: 900,
  subtotal: 900,
  total: 900,
  tax: 0,
  currency: 'usd',
  payment_intent: 'pi_1',
  hosted_invoice_url: 'https://stripe.test/inv',
  lines: { data: [{ period: { start: 1700000000, end: 1702600000 } }] },
  ...extra,
});

// ---- signatures
test('stripe webhook: valid signature applies, invalid/tampered/stale/missing are rejected', async () => {
  const owner = await register(app, 'Sig');
  const event = checkoutDone(owner);
  const body = JSON.stringify(event);
  assert.equal((await request(app).post('/api/webhooks/stripe').set('Content-Type', 'application/json').send(body)).status, 401);
  assert.equal((await postStripe(body, { sig: stripeSig(body, undefined, 'whsec_other') })).status, 401);
  assert.equal((await postStripe(body.replace('starter', 'business'), { sig: stripeSig(body) })).status, 401);
  assert.equal((await postStripe(body, { ts: Math.floor(clock / 1000) - 3600 })).status, 401);
  assert.equal((await sub(owner)).planId, 'free');
  assert.equal((await postStripe(body)).status, 200);
  assert.equal((await sub(owner)).planId, 'starter');
});

test('razorpay webhook: signature checked on raw body', async () => {
  const owner = await register(app, 'RzpSig');
  const event = {
    event: 'subscription.activated',
    created_at: Math.floor(clock / 1000),
    payload: { subscription: { entity: { id: 'sub_r1', plan_id: 'plan_p_m', customer_id: 'cust_r', current_end: Math.floor(clock / 1000) + 2592000, notes: { orgId: owner.orgId, planId: 'starter', interval: 'monthly' } } } },
  };
  assert.equal((await postRazorpay(event, 'e1', 'wrong')).status, 401);
  assert.equal((await postRazorpay(event, 'e2')).status, 200);
  const row = await sub(owner);
  // The plan comes from our price map (plan_p_m is pro), never from client-supplied notes.
  assert.equal(row.planId, 'pro');
  assert.equal(row.provider, 'razorpay');
  assert.equal(row.currency, 'INR');
});

test('webhooks answer 503 when the secret is not configured', async () => {
  useProviders({ STRIPE_WEBHOOK_SECRET: '', RAZORPAY_WEBHOOK_SECRET: '' });
  assert.equal((await postStripe({ id: 'x' })).status, 503);
  assert.equal((await postRazorpay({ event: 'x' })).status, 503);
});

// ---- idempotency and ordering
test('replayed events have no repeated effects', async () => {
  const owner = await register(app, 'Replay');
  await postStripe(checkoutDone(owner));
  const paid = stripeEvent('invoice.paid', invoiceObject());
  assert.equal((await postStripe(paid)).body.duplicate, false);
  assert.equal((await postStripe(paid)).body.duplicate, true);
  assert.equal((await store.list('invoice', { orgId: owner.orgId })).length, 1);
  assert.equal((await store.list('payment', { orgId: owner.orgId })).length, 1);
  assert.equal((await store.list('webhookEvent', { orgId: owner.orgId })).length, 2);
});

test('out-of-order events: stale updates never roll state back, early invoices wait', async () => {
  const owner = await register(app, 'Order');
  const t = Math.floor(clock / 1000);
  await postStripe(checkoutDone(owner, {}, 'sub_1', t));
  // newer upgrade to pro arrives first, then an older update that still says starter
  const upd = (plan, created, extra = {}) =>
    stripeEvent('customer.subscription.updated', {
      id: 'sub_1', customer: 'cus_1', status: 'active', cancel_at_period_end: false,
      current_period_end: t + 2592000, metadata: { orgId: owner.orgId, planId: plan, interval: 'monthly' },
      items: { data: [{ price: { id: plan === 'pro' ? 'price_p_m' : 'price_s_m' } }] }, ...extra,
    }, created);
  await postStripe(upd('pro', t + 100));
  await postStripe(upd('starter', t + 50));
  assert.equal((await sub(owner)).planId, 'pro');
  // a cancel for a different (replaced) subscription is ignored
  await postStripe(stripeEvent('customer.subscription.deleted', { id: 'sub_OLD', customer: 'cus_1', status: 'canceled', metadata: {} }, t + 200));
  assert.equal((await sub(owner)).planId, 'pro');
  // an invoice for an organization we cannot resolve yet is rejected (409) so Stripe retries it
  const orphan = stripeEvent('invoice.paid', invoiceObject('sub_unknown', { customer: 'cus_unknown' }));
  assert.equal((await postStripe(orphan)).status, 409);
  assert.equal((await store.list('webhookEvent', { eventId: orphan.id })).length, 0);
  // subscription update before checkout: metadata alone is enough to activate
  const early = await register(app, 'Early');
  await postStripe(upd('pro', t + 10, { id: 'sub_E', customer: 'cus_E', metadata: { orgId: early.orgId, planId: 'pro', interval: 'monthly' } }));
  assert.equal((await sub(early)).planId, 'pro');
});

// ---- billing lifecycle
test('invoice paid stores invoice and payment; failed starts dunning and emails the owner; paid again recovers', async () => {
  const owner = await register(app, 'Dun');
  await postStripe(checkoutDone(owner));
  await postStripe(stripeEvent('invoice.paid', invoiceObject()));
  const invoice = await store.find('invoice', { orgId: owner.orgId });
  assert.equal(invoice.status, 'paid');
  assert.equal(invoice.amount, 900);
  outbox.length = 0;
  const failed = stripeEvent('invoice.payment_failed', invoiceObject('sub_1', { id: 'in_2', number: 'INV-0002' }), Math.floor(clock / 1000) + 5);
  await postStripe(failed);
  let row = await sub(owner);
  assert.equal(row.status, 'past_due');
  assert.ok(row.pastDueSince);
  assert.equal(row.planId, 'starter');
  assert.equal(outbox.length, 1);
  assert.match(outbox[0].subject, /payment failed/i);
  assert.equal(outbox[0].to, owner.email);
  await postStripe(stripeEvent('invoice.paid', invoiceObject('sub_1', { id: 'in_3', number: 'INV-0003' }), Math.floor(clock / 1000) + 10));
  row = await sub(owner);
  assert.equal(row.status, 'active');
  assert.equal(row.pastDueSince, null);
});

test('dunning: after 7 days of non-payment the account is downgraded to Free', async () => {
  const owner = await register(app, 'Grace');
  await postStripe(checkoutDone(owner));
  await postStripe(stripeEvent('invoice.payment_failed', invoiceObject()));
  assert.equal(await runDunning(store, new Date(Date.now() + 6 * 86400000)), 0);
  assert.equal((await sub(owner)).planId, 'starter');
  outbox.length = 0;
  assert.equal(await runDunning(store, new Date(Date.now() + 8 * 86400000)), 1);
  const row = await sub(owner);
  assert.equal(row.planId, 'free');
  assert.equal(row.status, 'active');
  assert.equal(row.providerSubscriptionId, null);
  assert.match(outbox[0].subject, /Free plan/);
  // Stripe was asked to cancel the lapsed subscription
  assert.ok(calls.some((c) => c.url.includes('/subscriptions/sub_1')));
});

test('subscription deleted returns the account to Free; refunds are recorded', async () => {
  const owner = await register(app, 'Refund');
  await postStripe(checkoutDone(owner));
  await postStripe(stripeEvent('invoice.paid', invoiceObject()));
  await postStripe(stripeEvent('charge.refunded', { id: 'ch_1', payment_intent: 'pi_1', amount_refunded: 300, currency: 'usd' }));
  let payment = await store.find('payment', { providerId: 'pi_1' });
  assert.equal(payment.refundedAmount, 300);
  assert.equal(payment.status, 'partially_refunded');
  await postStripe(stripeEvent('charge.refunded', { id: 'ch_1', payment_intent: 'pi_1', amount_refunded: 900, currency: 'usd' }));
  payment = await store.find('payment', { providerId: 'pi_1' });
  assert.equal(payment.status, 'refunded');
  await postStripe(stripeEvent('customer.subscription.deleted', { id: 'sub_1', customer: 'cus_1', status: 'canceled', metadata: {} }, Math.floor(clock / 1000) + 50));
  assert.equal((await sub(owner)).planId, 'free');
});

test('razorpay charge records GST-inclusive invoice with the tax split', async () => {
  const owner = await register(app, 'Gst');
  const t = Math.floor(clock / 1000);
  const subEntity = { id: 'sub_r1', plan_id: 'plan_s_m', customer_id: 'cust_r', current_start: t, current_end: t + 2592000, notes: { orgId: owner.orgId } };
  await postRazorpay({ event: 'subscription.activated', created_at: t, payload: { subscription: { entity: subEntity } } });
  await store.create('billingProfile', { orgId: owner.orgId, gstin: '29ABCDE1234F1Z5', state: '29' });
  const total = 59900 + Math.round(59900 * 0.18);
  await postRazorpay({ event: 'subscription.charged', created_at: t + 1, payload: { subscription: { entity: subEntity }, payment: { entity: { id: 'pay_1', invoice_id: 'inv_r1', amount: total, currency: 'INR' } } } });
  const invoice = await store.find('invoice', { number: 'inv_r1' });
  assert.equal(invoice.amount, total);
  assert.equal(invoice.subtotal, 59900);
  assert.equal(invoice.tax, 10782);
  assert.equal(invoice.customerGstin, '29ABCDE1234F1Z5');
  assert.equal((await sub(owner)).planId, 'starter');
  await postRazorpay({ event: 'subscription.halted', created_at: t + 2, payload: { subscription: { entity: subEntity } } });
  assert.equal((await sub(owner)).status, 'past_due');
  await postRazorpay({ event: 'refund.processed', created_at: t + 3, payload: { refund: { entity: { id: 'rf_1', payment_id: 'pay_1', amount: 1000 } } } });
  assert.equal((await store.find('payment', { providerId: 'pay_1' })).refundedAmount, 1000);
});

test('GST computation: IGST across states, CGST+SGST in the same state, rounding sums to the tax', () => {
  const company = { COMPANY_STATE: '29', COMPANY_GSTIN: '' };
  assert.deepEqual(computeGst(59900, { state: '07' }, company), { subtotal: 59900, rate: 0.18, tax: 10782, total: 70682, breakdown: { igst: 10782 } });
  const same = computeGst(59900, { gstin: '29ABCDE1234F1Z5' }, company);
  assert.deepEqual(same.breakdown, { cgst: 5391, sgst: 5391 });
  const odd = computeGst(10001, { state: '29' }, company);
  assert.equal(odd.breakdown.cgst + odd.breakdown.sgst, odd.tax);
  assert.equal(computeGst(0, {}, company).total, 0);
});

// ---- endpoints
test('checkout creates provider sessions (Stripe USD, Razorpay INR) without trusting client amounts', async () => {
  const owner = await register(app, 'Co');
  responder = async (url) =>
    url.includes('stripe') ? { status: 200, json: { url: 'https://checkout.stripe.test/s1' } } : { status: 200, json: { id: 'sub_r', short_url: 'https://rzp.io/i/abc' } };
  let res = await owner.client.post('/api/billing/checkout').send({ planId: 'starter', currency: 'USD', interval: 'annual' });
  assert.equal(res.status, 200);
  assert.equal(res.body.url, 'https://checkout.stripe.test/s1');
  const call = calls.at(-1);
  assert.match(call.headers.Authorization, /^Bearer sk_test_x$/);
  const form = new URLSearchParams(call.body);
  assert.equal(form.get('line_items[0][price]'), 'price_s_a');
  assert.equal(form.get('client_reference_id'), owner.orgId);
  assert.equal(form.get('metadata[planId]'), 'starter');
  res = await owner.client.post('/api/billing/checkout').send({ planId: 'pro', currency: 'INR' });
  assert.equal(res.body.url, 'https://rzp.io/i/abc');
  const body = JSON.parse(calls.at(-1).body);
  assert.equal(body.plan_id, 'plan_p_m');
  assert.equal(body.notes.orgId, owner.orgId);
  // checkout never changes the plan by itself
  assert.equal((await sub(owner)).planId, 'free');
  assert.equal((await owner.client.post('/api/billing/checkout').send({ planId: 'nope', currency: 'USD' })).status, 404);
});

test('checkout is 503 when payments are not configured, or the plan has no provider price', async () => {
  const owner = await register(app, 'Unc');
  useProviders({ STRIPE_SECRET_KEY: '', RAZORPAY_KEY_ID: '' });
  let res = await owner.client.post('/api/billing/checkout').send({ planId: 'starter', currency: 'USD' });
  assert.equal(res.status, 503);
  assert.match(res.body.error, /not configured/i);
  assert.equal((await owner.client.post('/api/billing/checkout').send({ planId: 'starter', currency: 'INR' })).status, 503);
  const info = await owner.client.get('/api/billing');
  assert.deepEqual(info.body.providers, { razorpay: { configured: false, currency: 'INR' }, stripe: { configured: false, currency: 'USD' } });
  useProviders();
  res = await owner.client.post('/api/billing/checkout').send({ planId: 'business', currency: 'USD' });
  assert.equal(res.status, 503);
  assert.equal(calls.length, 0);
});

test('owner only: admins and viewers cannot change billing', async () => {
  const owner = await register(app, 'Own');
  const admin = await addMember(app, store, owner, { role: 'admin' });
  const viewer = await addMember(app, store, owner, { role: 'viewer' });
  for (const [method, path, body] of [
    ['post', '/api/billing/checkout', { planId: 'starter', currency: 'USD' }],
    ['post', '/api/billing/portal', {}],
    ['post', '/api/billing/cancel', {}],
    ['put', '/api/billing/profile', { legalName: 'X' }],
    ['post', '/api/billing/change', { planId: 'pro', interval: 'monthly' }],
  ])
    for (const who of [admin, viewer])
      assert.equal((await who.client[method](path).send(body)).status, 403, `${method} ${path}`);
  assert.equal((await admin.client.get('/api/billing')).status, 200);
  assert.equal((await admin.client.get('/api/billing')).body.canManage, false);
  assert.equal((await viewer.client.get('/api/billing')).status, 403);
  assert.equal((await owner.client.get('/api/billing')).body.canManage, true);
});

test('dev change endpoint only works with BILLING_DEV_MODE', async () => {
  const owner = await register(app, 'Dev');
  let res = await owner.client.post('/api/billing/change').send({ planId: 'pro', interval: 'monthly' });
  assert.equal(res.status, 403);
  assert.equal((await sub(owner)).planId, 'free');
  config.BILLING_DEV_MODE = true;
  res = await owner.client.post('/api/billing/change').send({ planId: 'pro', interval: 'monthly' });
  assert.equal(res.status, 200);
  assert.equal((await sub(owner)).planId, 'pro');
});

test('downgrades are blocked above plan limits with a plain-language message', async () => {
  const owner = await register(app, 'Down');
  config.BILLING_DEV_MODE = true;
  await owner.client.post('/api/billing/change').send({ planId: 'pro', interval: 'monthly' });
  for (let i = 0; i < 7; i++)
    await store.create('uptimeMonitor', {
      orgId: owner.orgId, projectId: owner.project.id, name: `m${i}`, target: `https://example.com/${i}`,
      intervalSeconds: 300, failureThreshold: 3, status: 'unknown',
    });
  const res = await owner.client.post('/api/billing/checkout').send({ planId: 'free', currency: 'USD' });
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'plan_limits_exceeded');
  assert.match(res.body.error, /7 website checks \(the Free plan allows 5\)/);
  assert.match(res.body.error, /Remove 2 website checks/);
  assert.equal((await sub(owner)).planId, 'pro');
  for (const m of (await store.list('uptimeMonitor', { orgId: owner.orgId })).slice(0, 2)) await store.remove('uptimeMonitor', m.id);
  const ok = await owner.client.post('/api/billing/checkout').send({ planId: 'free', currency: 'USD' });
  assert.equal(ok.body.switched, true);
  assert.equal((await sub(owner)).planId, 'free');
});

test('plan change on a paid subscription goes through the provider; cancel asks the provider', async () => {
  const owner = await register(app, 'Chg');
  await postStripe(checkoutDone(owner));
  responder = async (url, o) =>
    o.method === 'GET' ? { status: 200, json: { items: { data: [{ id: 'si_1' }] } } } : { status: 200, json: {} };
  let res = await owner.client.post('/api/billing/checkout').send({ planId: 'pro', currency: 'USD' });
  assert.equal(res.body.pending, true);
  const update = calls.at(-1);
  assert.match(update.url, /subscriptions\/sub_1$/);
  assert.equal(new URLSearchParams(update.body).get('items[0][price]'), 'price_p_m');
  assert.equal((await sub(owner)).planId, 'starter'); // only the webhook changes it
  assert.equal((await owner.client.post('/api/billing/checkout').send({ planId: 'starter', currency: 'USD' })).status, 400);
  assert.equal((await owner.client.post('/api/billing/checkout').send({ planId: 'pro', currency: 'INR' })).status, 409);
  res = await owner.client.post('/api/billing/cancel');
  assert.equal(res.status, 200);
  assert.equal(res.body.cancelAtPeriodEnd, true);
  assert.equal(new URLSearchParams(calls.at(-1).body).get('cancel_at_period_end'), 'true');
  res = await owner.client.post('/api/billing/checkout').send({ planId: 'free', currency: 'USD' });
  assert.equal(res.body.scheduled, true);
});

test('portal needs a Stripe customer; billing profile validates GSTIN', async () => {
  const owner = await register(app, 'Por');
  assert.equal((await owner.client.post('/api/billing/portal')).status, 400);
  await postStripe(checkoutDone(owner));
  responder = async () => ({ status: 200, json: { url: 'https://billing.stripe.test/p' } });
  const res = await owner.client.post('/api/billing/portal');
  assert.equal(res.body.url, 'https://billing.stripe.test/p');
  assert.equal(new URLSearchParams(calls.at(-1).body).get('customer'), 'cus_1');
  assert.equal((await owner.client.put('/api/billing/profile').send({ gstin: 'bad' })).status, 400);
  const saved = await owner.client.put('/api/billing/profile').send({ legalName: 'Acme Pvt Ltd', gstin: '29abcde1234f1z5', state: '29' });
  assert.equal(saved.body.gstin, '29ABCDE1234F1Z5');
  assert.equal((await owner.client.get('/api/billing')).body.profile.legalName, 'Acme Pvt Ltd');
});
