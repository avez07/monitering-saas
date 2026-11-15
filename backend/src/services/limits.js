import { assert } from '../lib/errors.js';

/** In-memory fixed-window counters. Fine for a single API process; move to the database if we ever scale out. */
export class Limits {
  /**
   * Entries expire with their window and are swept as the map grows. If a flood of distinct keys still
   * fills it, the oldest plain rate-limit counters are evicted first. Failure counters (`record`, the
   * login and API-key lockouts) are "sticky": they are only ever removed by expiry, never by eviction.
   */
  constructor({ softLimit = 10000, hardLimit = 100000, stickyLimit = 1000000 } = {}) {
    this.windows = new Map(); // id -> { count, expiresAt, sticky }
    this.softLimit = softLimit;
    this.hardLimit = hardLimit;
    this.stickyLimit = stickyLimit;
    this.nextSweepAt = 0;
    this.nextForcedSweepAt = 0;
  }
  #id(key, seconds) {
    return `${key}:${Math.floor(Date.now() / (seconds * 1000))}`;
  }
  #sweep(now) {
    for (const [id, entry] of this.windows) if (entry.expiresAt <= now) this.windows.delete(id);
    this.nextSweepAt = now + 1000;
    this.nextForcedSweepAt = 0;
    if (this.windows.size <= this.hardLimit) return;
    // Still too big: drop the oldest non-sticky counters (Map keeps insertion order).
    const target = Math.floor(this.hardLimit * 0.9);
    for (const [id, entry] of this.windows) {
      if (this.windows.size <= target) break;
      if (!entry.sticky) this.windows.delete(id);
    }
    // Mostly sticky entries left: do not rescan on every request.
    if (this.windows.size > target) this.nextForcedSweepAt = now + 1000;
    // Pathological: only sticky entries remain above the cap; shed the oldest of those last.
    for (const id of this.windows.keys()) {
      if (this.windows.size <= this.stickyLimit) break;
      this.windows.delete(id);
    }
  }
  #add(key, amount, seconds, sticky = false) {
    const now = Date.now();
    const size = this.windows.size;
    if (
      (size > this.softLimit && now >= this.nextSweepAt) ||
      (size > this.hardLimit && now >= this.nextForcedSweepAt)
    )
      this.#sweep(now);
    const id = this.#id(key, seconds);
    const entry = this.windows.get(id);
    const count = (entry?.count || 0) + amount;
    this.windows.set(id, {
      count,
      sticky: sticky || Boolean(entry?.sticky),
      expiresAt: (Math.floor(now / (seconds * 1000)) + 1) * seconds * 1000,
    });
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
    this.#add(key, 1, seconds, true);
  }
  /** Reject when the window total has already reached `maximum`, without counting. */
  async assertUnder(key, maximum, seconds, message) {
    assert(
      (this.windows.get(this.#id(key, seconds))?.count || 0) < maximum,
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
export const createLimits = () => new Limits();
