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
import { GST_RATE } from '../billing-tax.js';

const API = 'https://api.razorpay.com/v1';
const seconds = (n) => (n ? new Date(n * 1000) : null);
const TERMS = { monthly: 120, annual: 10 };

export function createRazorpay({ config, http = fetchHttp }) {
  const priceMap = () => parsePriceMap(config.BILLING_PRICE_MAP);
  async function call(method, path, body) {
    if (!config.RAZORPAY_KEY_ID || !config.RAZORPAY_KEY_SECRET) throw notConfigured();
    const auth = Buffer.from(`${config.RAZORPAY_KEY_ID}:${config.RAZORPAY_KEY_SECRET}`).toString(
      'base64',
    );
    const response = await http(`${API}${path}`, {
      method,
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status >= 400 || !response.json) {
      console.error(
        `[razorpay] ${method} ${path} -> ${response.status} ${response.json?.error?.description || ''}`,
      );
      throw providerFailure('complete the request');
    }
    return response.json;
  }
  return {
    name: 'razorpay',
    currency: 'INR',
    get configured() {
      return Boolean(config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET);
    },
    get webhookConfigured() {
      return Boolean(config.RAZORPAY_WEBHOOK_SECRET);
    },
    priceId: (planId, interval) => priceIdFor(priceMap(), 'razorpay', planId, interval),
    planFromPrice: (priceId) => planFromPrice(priceMap(), 'razorpay', priceId),
    async createCheckout({ orgId, planId, interval, priceId, email }) {
      const subscription = await call('POST', '/subscriptions', {
        plan_id: priceId,
        total_count: TERMS[interval] || 120,
        customer_notify: 1,
        notes: { orgId, planId, interval },
        ...(email ? { notify_info: { notify_email: email } } : {}),
      });
      if (!subscription.short_url) throw providerFailure('start checkout');
      return { url: subscription.short_url };
    },
    async cancelSubscription({ subscriptionId }) {
      await call('POST', `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
        cancel_at_cycle_end: 1,
      });
    },
    async changePlan({ subscriptionId, priceId, atCycleEnd }) {
      await call('PATCH', `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        plan_id: priceId,
        schedule_change_at: atCycleEnd ? 'cycle_end' : 'now',
      });
    },
    /** Razorpay signs the raw body with HMAC-SHA256 (hex) in `X-Razorpay-Signature`. */
    verifyWebhook(rawBody, headers) {
      if (!config.RAZORPAY_WEBHOOK_SECRET) throw notConfigured();
      const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
      const expected = hmacHex(config.RAZORPAY_WEBHOOK_SECRET, body);
      if (!safeEqualHex(expected, headers['x-razorpay-signature']))
        throw new HttpError(401, 'Invalid webhook signature.');
      let event;
      try {
        event = JSON.parse(body);
      } catch {
        throw new HttpError(400, 'Invalid JSON.');
      }
      event.__id = headers['x-razorpay-event-id'] || null;
      return event;
    },
    normalizeEvent(event) {
      const payload = event.payload || {};
      const sub = payload.subscription?.entity;
      const payment = payload.payment?.entity;
      const refund = payload.refund?.entity;
      const base = {
        provider: 'razorpay',
        eventId:
          event.__id ||
          `${event.event}:${sub?.id || refund?.id || payment?.id}:${event.created_at}`,
        createdAt: seconds(event.created_at) || new Date(),
      };
      const fromSub = () => {
        const mapped = this.planFromPrice(sub?.plan_id);
        return {
          orgId: sub?.notes?.orgId || null,
          planId: mapped?.planId || sub?.notes?.planId || null,
          interval: mapped?.interval || sub?.notes?.interval || null,
          subscriptionId: sub?.id || null,
          customerId: sub?.customer_id || null,
          periodEnd: seconds(sub?.current_end),
          currency: 'INR',
        };
      };
      switch (event.event) {
        case 'subscription.activated':
          return { ...base, ...fromSub(), type: 'checkout.completed' };
        case 'subscription.updated':
          return { ...base, ...fromSub(), type: 'subscription.updated', status: 'active' };
        case 'subscription.charged': {
          const total = payment?.amount ?? 0;
          const subtotal = Math.round(total / (1 + GST_RATE));
          return {
            ...base,
            ...fromSub(),
            type: 'invoice.paid',
            invoice: {
              number: payment?.invoice_id || payment?.id,
              total,
              subtotal,
              tax: total - subtotal,
              currency: payment?.currency || 'INR',
              periodStart: seconds(sub?.current_start),
              periodEnd: seconds(sub?.current_end),
              url: null,
              paymentId: payment?.id,
            },
          };
        }
        case 'subscription.pending':
        case 'subscription.halted':
          return {
            ...base,
            ...fromSub(),
            type: 'invoice.failed',
            invoice: { number: null, paymentId: null, total: 0, currency: 'INR' },
          };
        case 'subscription.cancelled':
        case 'subscription.completed':
          return { ...base, ...fromSub(), type: 'subscription.cancelled' };
        case 'refund.processed':
          return {
            ...base,
            type: 'refund.created',
            refund: {
              paymentIds: [refund?.payment_id].filter(Boolean),
              amount: refund?.amount ?? 0,
            },
          };
        default:
          return { ...base, type: 'ignored' };
      }
    },
  };
}
