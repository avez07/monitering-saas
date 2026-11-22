import express, { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { assert } from '../lib/errors.js';
import { permit, audit } from '../services/auth.js';
import {
  billingProvider,
  downgradeProblems,
  assertCanSwitch,
  processProviderEvent,
  planChanged,
  GRACE_DAYS,
} from '../services/billing.js';
import { GST_RATE, GSTIN_PATTERN } from '../services/billing-tax.js';
import { getProviders, providerForCurrency } from '../services/billing-providers/index.js';

const text = (max) => z.string().trim().max(max);
const profileSchema = z
  .object({
    legalName: text(150),
    email: z.union([z.string().trim().email().max(200), z.literal('')]),
    country: text(2),
    state: text(2),
    gstin: z.union([z.string().trim().toUpperCase().regex(GSTIN_PATTERN, 'Enter a valid 15-character GSTIN.'), z.literal('')]),
    address: text(500),
  })
  .partial()
  .strict();
const emptyProfile = { legalName: '', email: '', country: '', state: '', gstin: '', address: '' };
const publicProfile = (row) => (row ? { ...emptyProfile, ...pick(row) } : { ...emptyProfile });
const pick = ({ legalName, email, country, state, gstin, address }) => ({
  legalName,
  email,
  country,
  state,
  gstin,
  address,
});
const returnUrl = (state) =>
  `${config.APP_URL.replace(/\/$/, '')}/settings/billing?checkout=${state}`;

export function billingRoutes(store) {
  const router = Router();

  router.get('/billing', permit('owner', 'admin'), async (req, res) => {
    const { orgId, membership } = req.context;
    const invoices = (await store.list('invoice', { orgId })).sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    );
    const providers = getProviders();
    res.json({
      plans: await store.list('subscriptionPlan'),
      subscription: await store.find('subscription', { orgId }),
      invoices,
      provider: billingProvider.name,
      providers: {
        razorpay: { configured: providers.razorpay.configured, currency: 'INR' },
        stripe: { configured: providers.stripe.configured, currency: 'USD' },
      },
      defaultCurrency: 'INR',
      devMode: config.BILLING_DEV_MODE,
      gst: { rate: GST_RATE },
      graceDays: GRACE_DAYS,
      profile: publicProfile(await store.find('billingProfile', { orgId })),
      canManage: membership.role === 'owner',
    });
  });

  router.get('/billing/profile', permit('owner', 'admin'), async (req, res) =>
    res.json(publicProfile(await store.find('billingProfile', { orgId: req.context.orgId }))),
  );
  router.put('/billing/profile', permit('owner'), async (req, res) => {
    const input = profileSchema.parse(req.body);
    const { orgId } = req.context;
    const row = await store.find('billingProfile', { orgId });
    const saved = row
      ? await store.update('billingProfile', row.id, input)
      : await store.create('billingProfile', { orgId, ...input });
    await audit(store, req.context, 'billing.profile_updated', saved.legalName || 'billing profile');
    res.json(publicProfile(saved));
  });

  router.post('/billing/checkout', permit('owner'), async (req, res) => {
    const input = z
      .object({
        planId: z.string().min(1).max(100),
        interval: z.enum(['monthly', 'annual']).default('monthly'),
        currency: z.enum(['USD', 'INR']).default('INR'),
      })
      .parse(req.body);
    const { orgId, user } = req.context;
    const plan = await store.find('subscriptionPlan', { id: input.planId });
    assert(plan, 404, 'Plan not found.');
    const subscription = await store.find('subscription', { orgId });
    assertCanSwitch(await downgradeProblems(store, orgId, plan), plan);

    if (plan.id === 'free') {
      if (subscription.providerSubscriptionId) {
        const provider = getProviders()[subscription.provider];
        assert(provider?.configured, 503, 'Payments are not configured yet. Please contact support.');
        await provider.cancelSubscription({ subscriptionId: subscription.providerSubscriptionId });
        await store.update('subscription', subscription.id, { cancelAtPeriodEnd: true });
        await audit(store, req.context, 'subscription.downgrade_scheduled', plan.name);
        return res.json({ scheduled: true, effectiveAt: subscription.periodEnd });
      }
      if (subscription.planId !== 'free')
        await store.update('subscription', subscription.id, {
          planId: 'free',
          status: 'active',
          cancelAtPeriodEnd: false,
          pastDueSince: null,
          periodEnd: new Date(Date.now() + 3650 * 86400000),
        });
      await planChanged(store, orgId);
      await audit(store, req.context, 'subscription.changed', plan.name);
      return res.json({ switched: true });
    }

    const provider = providerForCurrency(input.currency);
    assert(provider.configured, 503, 'Payments are not configured yet. Please contact support.');
    const priceId = provider.priceId(plan.id, input.interval);
    assert(priceId, 503, 'This plan cannot be bought online yet. Please contact support.');

    if (subscription.providerSubscriptionId) {
      assert(
        subscription.provider === provider.name,
        409,
        `Your current plan is billed through ${subscription.provider === 'razorpay' ? 'Razorpay (INR)' : 'Stripe (USD)'}. Cancel it first to switch currency.`,
      );
      assert(
        !(plan.id === subscription.planId && input.interval === subscription.interval),
        400,
        'You are already on this plan.',
      );
      const current = await store.find('subscriptionPlan', { id: subscription.planId });
      const upgrade = plan.priceUsdCents * (input.interval === 'annual' ? 10 : 1) >
        current.priceUsdCents * (subscription.interval === 'annual' ? 10 : 1);
      await provider.changePlan({
        subscriptionId: subscription.providerSubscriptionId,
        priceId,
        planId: plan.id,
        interval: input.interval,
        atCycleEnd: !upgrade,
      });
      await audit(store, req.context, 'subscription.change_requested', plan.name);
      return res.json({
        pending: true,
        message: upgrade
          ? 'Your plan change was sent to the payment provider. It will show here in a few seconds.'
          : 'Your plan will change at the end of the current billing period.',
      });
    }

    const profile = await store.find('billingProfile', { orgId });
    const customer = await store.find('billingCustomer', { orgId });
    const checkout = await provider.createCheckout({
      orgId,
      planId: plan.id,
      interval: input.interval,
      priceId,
      customerId: customer?.provider === provider.name ? customer.providerId : undefined,
      email: profile?.email || user.email,
      successUrl: returnUrl('success'),
      cancelUrl: returnUrl('cancelled'),
    });
    await audit(store, req.context, 'subscription.checkout_started', plan.name, {
      provider: provider.name,
    });
    res.json({ url: checkout.url });
  });

  router.post('/billing/portal', permit('owner'), async (req, res) => {
    const customer = await store.find('billingCustomer', { orgId: req.context.orgId });
    assert(customer?.provider === 'stripe', 400, 'The billing portal is only available for card (USD) subscriptions.');
    const stripe = getProviders().stripe;
    assert(stripe.configured, 503, 'Payments are not configured yet. Please contact support.');
    res.json(
      await stripe.createPortal({
        customerId: customer.providerId,
        returnUrl: `${config.APP_URL.replace(/\/$/, '')}/settings/billing`,
      }),
    );
  });

  router.post('/billing/cancel', permit('owner'), async (req, res) => {
    const row = await store.find('subscription', { orgId: req.context.orgId });
    assert(row.planId !== 'free', 400, 'You are on the Free plan, so there is nothing to cancel.');
    if (row.providerSubscriptionId) {
      const provider = getProviders()[row.provider];
      assert(provider?.configured, 503, 'Payments are not configured yet. Please contact support.');
      await provider.cancelSubscription({ subscriptionId: row.providerSubscriptionId });
    }
    const updated = await store.update('subscription', row.id, { cancelAtPeriodEnd: true });
    await audit(store, req.context, 'subscription.cancelled', row.planId);
    res.json(updated);
  });

  // Dev only: switch plans with no payment. Real plan changes happen through verified provider webhooks.
  router.post('/billing/change', permit('owner'), async (req, res) => {
    assert(
      config.BILLING_DEV_MODE,
      403,
      'Plan changes go through checkout. Use the Upgrade button on the Plan & billing page.',
    );
    const input = z
      .object({
        planId: z.string().min(1).max(100),
        interval: z.enum(['monthly', 'annual']),
        currency: z.enum(['USD', 'INR']).default('INR'),
      })
      .parse(req.body);
    const plan = await store.find('subscriptionPlan', { id: input.planId });
    assert(plan, 404, 'Plan not found.');
    assertCanSwitch(await downgradeProblems(store, req.context.orgId, plan), plan);
    const invoice = await billingProvider.changeSubscription(
      store,
      req.context.orgId,
      plan,
      input.interval,
      input.currency,
    );
    await planChanged(store, req.context.orgId);
    await audit(store, req.context, 'subscription.changed', plan.name, { provider: 'mock' });
    res.json({ invoice, message: 'Plan updated. No money was charged (development mode).' });
  });
  return router;
}

/**
 * Provider webhooks. They need the exact raw bytes for signature checks, so this router must be mounted
 * before express.json(). No cookies or CSRF: the signature is the authentication.
 */
export function billingWebhookRoutes(store) {
  const router = Router();
  const raw = express.raw({ type: () => true, limit: '512kb' });
  for (const name of ['stripe', 'razorpay'])
    router.post(`/${name}`, raw, async (req, res) => {
      const provider = getProviders()[name];
      const event = provider.verifyWebhook(req.body, req.headers);
      const result = await processProviderEvent(store, provider.normalizeEvent(event));
      res.json({ received: true, ...result });
    });
  return router;
}
