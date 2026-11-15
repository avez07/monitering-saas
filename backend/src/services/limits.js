import { assert } from '../lib/errors.js';

/** In-memory fixed-window counters. Fine for a single API process; move to the database if we ever scale out. */
export class Limits {
  constructor() {
    this.windows = new Map();
  }
  #id(key, seconds) {
    return `${key}:${Math.floor(Date.now() / (seconds * 1000))}`;
  }
  #add(key, amount, seconds) {
    if (this.windows.size > 20000) this.windows.clear();
    const id = this.#id(key, seconds);
    const count = (this.windows.get(id) || 0) + amount;
    this.windows.set(id, count);
    return count;
  }
  /** Count a hit and reject when the window total exceeds `maximum`. */
  async use(key, amount, maximum, seconds = 60) {
    assert(
      this.#add(key, amount, seconds) <= maximum,
      429,
      'Usage limit reached. Please retry after the current window.',
    );
  }
  /** Count a hit without rejecting (used for failed-login counters). */
  async record(key, seconds = 60) {
    this.#add(key, 1, seconds);
  }
  /** Reject when the window total has already reached `maximum`, without counting. */
  async assertUnder(key, maximum, seconds, message) {
    assert(
      (this.windows.get(this.#id(key, seconds)) || 0) < maximum,
      429,
      message || 'Too many attempts. Please try again later.',
    );
  }
}

const limitKeys = {
  servers: 'includedServers',
  members: 'members',
  alertRules: 'alertRules',
  monitors: 'monitors',
};
/**
 * Maximum count of a resource a plan allows. Paid plans may add servers beyond the included number
 * (billed per extra server once billing ships), so only the free plan hard-caps servers.
 */
export function planLimit(plan, key) {
  if (key === 'servers' && plan.extraServerUsdCents > 0) return Infinity;
  return plan[limitKeys[key]];
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
      Date.now() - new Date(subscription.pastDueSince || subscription.updatedAt).getTime() < 7 * 86400000,
      402,
      'The payment grace period has ended.',
    );
  const plan = await store.find('subscriptionPlan', { id: subscription.planId });
  assert(plan, 403, 'Subscription plan not found.');
  return { plan, subscription };
}
export async function enforceCount(store, orgId, key, count) {
  const { plan } = await entitlements(store, orgId);
  const limit = planLimit(plan, key);
  assert(count < limit, 402, `Your ${plan.name} plan allows ${limit} ${key}. Upgrade to add more.`);
}
export const createLimits = () => new Limits();
