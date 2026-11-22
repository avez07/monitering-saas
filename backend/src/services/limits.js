import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { assert } from '../lib/errors.js';
import { getRedis } from '../lib/redis.js';

/**
 * Fixed-window counters shared by every API instance through Redis (rate-limiter-flexible). Counters
 * expire with their window and Redis runs with noeviction, so failure counters (`record`, the login and
 * API-key lockouts) can never be pushed out by a flood of other keys. If Redis is unreachable the call
 * rejects (fails closed with a 500) rather than silently disabling the limit.
 */
export class Limits {
  constructor({ redis = getRedis() } = {}) {
    this.redis = redis;
    this.limiters = new Map(); // "points:seconds" -> RateLimiterRedis
  }
  #limiter(maximum, seconds) {
    const id = `${maximum}:${seconds}`;
    let limiter = this.limiters.get(id);
    if (!limiter)
      this.limiters.set(
        id,
        (limiter = new RateLimiterRedis({
          storeClient: this.redis,
          keyPrefix: 'rl',
          points: maximum,
          duration: seconds,
        })),
      );
    return limiter;
  }
  /** The window length is part of the key, so the same name with another window is a separate counter. */
  #key = (key, seconds) => `${key}|${seconds}`;
  async #consume(key, amount, maximum, seconds) {
    try {
      await this.#limiter(maximum, seconds).consume(this.#key(key, seconds), amount);
      return true;
    } catch (error) {
      if (error instanceof RateLimiterRes) return false;
      throw error;
    }
  }
  /** Count a hit and reject when the window total exceeds `maximum`. */
  async use(key, amount, maximum, seconds = 60) {
    assert(
      await this.#consume(key, amount, maximum, seconds),
      429,
      'Usage limit reached. Please retry after the current window.',
    );
  }
  /** Count a hit without rejecting (used for failed-login counters). */
  async record(key, seconds = 60) {
    await this.#consume(key, 1, Number.MAX_SAFE_INTEGER, seconds);
  }
  /** Reject when the window total has already reached `maximum`, without counting. */
  async assertUnder(key, maximum, seconds, message) {
    const state = await this.#limiter(maximum, seconds).get(this.#key(key, seconds));
    assert(
      (state?.consumedPoints || 0) < maximum,
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
/** True when the plan switches on a premium feature (`advancedDashboard`, `promMetrics`). */
export function hasFeature(plan, name) {
  const features = plan?.features;
  return Boolean(features && typeof features === 'object' && !Array.isArray(features) && features[name] === true);
}
/**
 * Whether the organization's current subscription includes a feature. An expired or missing subscription
 * includes nothing (no error is thrown).
 */
export async function orgHasFeature(store, orgId, name) {
  try {
    const { plan } = await entitlements(store, orgId);
    return hasFeature(plan, name);
  } catch (error) {
    if (error.status === 402 || error.status === 403) return false;
    throw error;
  }
}
const featureKey = (orgId) => `feat:${orgId}`;
/**
 * `{ planId, planName, features }` of the organization's current subscription, cached in Redis for a short
 * time (hot agent paths: remote_write, logs). `planId` is null when there is no valid subscription.
 * Plan changes drop the entry (`forgetOrgFeatures`), so they apply at once.
 */
export async function orgPlanCached(store, orgId, seconds = 30) {
  const redis = getRedis();
  const hit = await redis.get(featureKey(orgId));
  if (hit) return JSON.parse(hit);
  let value;
  try {
    const { plan } = await entitlements(store, orgId);
    value = { planId: plan.id, planName: plan.name, features: plan.features ?? {} };
  } catch (error) {
    if (error.status !== 402 && error.status !== 403) throw error;
    value = { planId: null, planName: null, features: {} };
  }
  await redis.set(featureKey(orgId), JSON.stringify(value), 'EX', seconds);
  return value;
}
export const forgetOrgFeatures = (orgId) => getRedis().del(featureKey(orgId));
/** Rejects with 402 unless the organization's plan includes the feature. */
export async function requireFeature(store, orgId, name, message) {
  const { plan } = await entitlements(store, orgId);
  assert(hasFeature(plan, name), 402, message || `Your ${plan.name} plan does not include this. Upgrade to Pro.`);
  return plan;
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
      Date.now() - new Date(subscription.pastDueSince || subscription.updatedAt).getTime() <
        7 * 86400000,
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
  const noun = limit === 1 ? key.replace(/s$/, '') : key; // "1 member", "2 members"
  assert(
    count < limit,
    402,
    `Your ${plan.name} plan allows ${limit} ${noun}. Upgrade to add more.`,
  );
}
export const createLimits = (options) => new Limits(options);
