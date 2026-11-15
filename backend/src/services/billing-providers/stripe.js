import { HttpError } from '../../lib/errors.js';
import {
  fetchHttp,
  hmacHex,
  safeEqualHex,
  notConfigured,
  providerFailure,
  parsePriceMap,
  priceIdFor,
  planFromPrice,
} from './common.js';

const API = 'https://api.stripe.com/v1';
export const STRIPE_TOLERANCE_SECONDS = 300;

/** Stripe wants application/x-www-form-urlencoded with bracketed keys for nested values. */
export function formEncode(value, prefix = '', out = []) {
  if (value && typeof value === 'object')
    for (const [key, inner] of Object.entries(value))
      formEncode(inner, prefix ? `${prefix}[${key}]` : key, out);
  else if (value !== undefined && value !== null)
    out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(value)}`);
  return out;
}

const STATUS = {
  active: 'active',
  trialing: 'active',
  past_due: 'past_due',
  unpaid: 'past_due',
  canceled: 'cancelled',
};
const seconds = (n) => (n ? new Date(n * 1000) : null);

export function createStripe({ config, http = fetchHttp, now = () => Date.now() }) {
  const priceMap = () => parsePriceMap(config.BILLING_PRICE_MAP);
  async function call(method, path, params) {
    if (!config.STRIPE_SECRET_KEY) throw notConfigured();
    const response = await http(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params ? formEncode(params).join('&') : undefined,
    });
    if (response.status >= 400 || !response.json) {
      console.error(
        `[stripe] ${method} ${path} -> ${response.status} ${response.json?.error?.message || ''}`,
      );
      throw providerFailure('complete the request');
    }
    return response.json;
  }
  return {
    name: 'stripe',
    currency: 'USD',
    get configured() {
      return Boolean(config.STRIPE_SECRET_KEY);
    },
    get webhookConfigured() {
      return Boolean(config.STRIPE_WEBHOOK_SECRET);
    },
    priceId: (planId, interval) => priceIdFor(priceMap(), 'stripe', planId, interval),
    planFromPrice: (priceId) => planFromPrice(priceMap(), 'stripe', priceId),
    async createCheckout({ orgId, planId, interval, priceId, customerId, email, successUrl, cancelUrl }) {
      const metadata = { orgId, planId, interval };
      const session = await call('POST', '/checkout/sessions', {
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: orgId,
        ...(customerId ? { customer: customerId } : email ? { customer_email: email } : {}),
        metadata,
        subscription_data: { metadata },
      });
      if (!session.url) throw providerFailure('start checkout');
      return { url: session.url };
    },
    async createPortal({ customerId, returnUrl }) {
      const session = await call('POST', '/billing_portal/sessions', {
        customer: customerId,
        return_url: returnUrl,
      });
      return { url: session.url };
    },
    async cancelSubscription({ subscriptionId }) {
      await call('POST', `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        cancel_at_period_end: 'true',
      });
    },
    async changePlan({ subscriptionId, priceId, planId, interval }) {
      const subscription = await call('GET', `/subscriptions/${encodeURIComponent(subscriptionId)}`);
      const item = subscription.items?.data?.[0];
      if (!item) throw providerFailure('change the plan');
      await call('POST', `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        items: [{ id: item.id, price: priceId }],
        proration_behavior: 'create_prorations',
        cancel_at_period_end: 'false',
        metadata: { planId, interval },
      });
    },
    /** Verify `Stripe-Signature` (t=..,v1=..) over the exact raw body; returns the parsed event. */
    verifyWebhook(rawBody, headers) {
      if (!config.STRIPE_WEBHOOK_SECRET) throw notConfigured();
      const header = String(headers['stripe-signature'] || '');
      const parts = header.split(',').map((p) => p.trim().split('='));
      const timestamp = Number(parts.find(([k]) => k === 't')?.[1]);
      const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
      const bad = () => new HttpError(401, 'Invalid webhook signature.');
      if (!Number.isFinite(timestamp) || !signatures.length) throw bad();
      const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
      const expected = hmacHex(config.STRIPE_WEBHOOK_SECRET, `${timestamp}.${body}`);
      if (!signatures.some((s) => safeEqualHex(expected, s))) throw bad();
      if (Math.abs(now() / 1000 - timestamp) > STRIPE_TOLERANCE_SECONDS)
        throw new HttpError(401, 'Webhook timestamp is outside the allowed window.');
      try {
        return JSON.parse(body);
      } catch {
        throw new HttpError(400, 'Invalid JSON.');
      }
    },
    /** Reduce a Stripe event to the provider-neutral shape the billing service understands. */
    normalizeEvent(event) {
      const object = event.data?.object || {};
      const base = {
        provider: 'stripe',
        eventId: event.id,
        createdAt: seconds(event.created) || new Date(),
      };
      switch (event.type) {
        case 'checkout.session.completed': {
          if (object.mode !== 'subscription') return { ...base, type: 'ignored' };
          return {
            ...base,
            type: 'checkout.completed',
            orgId: object.metadata?.orgId || object.client_reference_id || null,
            planId: object.metadata?.planId || null,
            interval: object.metadata?.interval || null,
            subscriptionId: object.subscription || null,
            customerId: object.customer || null,
            currency: 'USD',
          };
        }
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          const item = object.items?.data?.[0];
          const mapped = this.planFromPrice(item?.price?.id);
          return {
            ...base,
            type: event.type.endsWith('deleted') ? 'subscription.cancelled' : 'subscription.updated',
            orgId: object.metadata?.orgId || null,
            planId: mapped?.planId || object.metadata?.planId || null,
            interval: mapped?.interval || object.metadata?.interval || null,
            subscriptionId: object.id,
            customerId: object.customer || null,
            status: STATUS[object.status] || null,
            periodEnd: seconds(object.current_period_end || item?.current_period_end),
            cancelAtPeriodEnd: Boolean(object.cancel_at_period_end),
            currency: 'USD',
          };
        }
        case 'invoice.paid':
        case 'invoice.payment_failed': {
          const line = object.lines?.data?.[0];
          const details = object.subscription_details || object.parent?.subscription_details || {};
          return {
            ...base,
            type: event.type === 'invoice.paid' ? 'invoice.paid' : 'invoice.failed',
            orgId: details.metadata?.orgId || null,
            subscriptionId: object.subscription || details.subscription || null,
            customerId: object.customer || null,
            invoice: {
              number: object.number || object.id,
              total: object.amount_paid ?? object.total ?? 0,
              subtotal: object.subtotal ?? object.total ?? 0,
              tax: object.tax ?? 0,
              currency: String(object.currency || 'usd').toUpperCase(),
              periodStart: seconds(line?.period?.start || object.period_start),
              periodEnd: seconds(line?.period?.end || object.period_end),
              url: object.hosted_invoice_url || null,
              paymentId: object.payment_intent || object.charge || object.id,
            },
          };
        }
        case 'charge.refunded':
          return {
            ...base,
            type: 'refund.created',
            customerId: object.customer || null,
            refund: {
              paymentIds: [object.payment_intent, object.id].filter(Boolean),
              totalRefunded: object.amount_refunded ?? 0,
            },
          };
        default:
          return { ...base, type: 'ignored' };
      }
    },
  };
}
