import { config } from '../config.js';
import { assert } from '../lib/errors.js';

export class Limits {
  constructor(redis = null) {
    this.redis = redis;
    this.windows = new Map();
  }
  async use(key, amount, maximum, seconds = 60) {
    const window = Math.floor(Date.now() / (seconds * 1000));
    const id = `pulse:${key}:${window}`;
    let count;
    if (this.redis) {
      count = Number(
        await this.redis.eval(
          "local n=redis.call('INCRBY',KEYS[1],ARGV[1]); if n==tonumber(ARGV[1]) then redis.call('EXPIRE',KEYS[1],ARGV[2]) end; return n",
          1,
          id,
          amount,
          seconds + 1,
        ),
      );
    } else {
      if (this.windows.size > 5000) this.windows.clear();
      count = (this.windows.get(id) || 0) + amount;
      this.windows.set(id, count);
    }
    assert(count <= maximum, 429, 'Usage limit reached. Please retry after the current window.');
  }
}
export async function entitlements(store, orgId) {
  const subscription = await store.find('subscription', { orgId });
  assert(subscription, 403, 'An active subscription is required.');
  const expired = subscription.periodEnd && new Date(subscription.periodEnd) < new Date();
  assert(
    ['trialing', 'active', 'past_due'].includes(subscription.status) &&
      !(expired && (subscription.status === 'trialing' || subscription.cancelAtPeriodEnd)),
    402,
    'Your subscription has expired.',
  );
  if (subscription.status === 'past_due')
    assert(
      Date.now() - new Date(subscription.updatedAt).getTime() < 7 * 86400000,
      402,
      'The payment grace period has ended.',
    );
  const plan = await store.find('subscriptionPlan', { id: subscription.planId });
  assert(plan, 403, 'Subscription plan not found.');
  return { plan, subscription };
}
export async function enforceCount(store, orgId, key, count) {
  const { plan } = await entitlements(store, orgId);
  assert(
    count < plan[key],
    402,
    `Your ${plan.name} plan allows ${plan[key]} ${key}. Upgrade to add more.`,
  );
}
export function month() {
  return new Date().toISOString().slice(0, 7);
}
export async function meter(store, orgId, kind, bytes, plan) {
  const period = month();
  const quota =
    { logs: plan.logGb, traces: plan.traceGb, metrics: plan.metricsGb }[kind] * 1024 ** 3;
  // Reservation happens before forwarding. Rejected upstream requests are conservatively metered.
  for (let attempt = 0; attempt < 8; attempt++) {
    let row = await store.find('usageAggregate', { orgId, kind, period });
    if (!row) {
      try {
        row = await store.create('usageAggregate', { orgId, kind, period, bytes: 0, requests: 0 });
      } catch (error) {
        if (error.code !== 'P2002') throw error;
        continue;
      }
    }
    assert(row.bytes + bytes <= quota, 429, `Monthly ${kind} quota reached.`);
    if (
      await store.claim(
        'usageAggregate',
        row.id,
        { bytes: row.bytes },
        { bytes: row.bytes + bytes, requests: row.requests + 1 },
      )
    )
      return;
  }
  assert(false, 503, 'Usage accounting is busy. Retry shortly.');
}
export async function createLimits() {
  if (config.DEMO_MODE) return new Limits();
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
  await redis.ping();
  return new Limits(redis);
}
