import { HttpError } from '../lib/errors.js';

/**
 * Which organizations a platform admin has suspended. Every org API request, agent /v1 request and
 * worker job asks, so the answer is the set of suspended ids (normally empty or tiny), read with one
 * query and cached per store for TTL_MS. Suspending or reactivating in this process bumps `generation`,
 * which drops every cached set at once; other processes catch up within TTL_MS.
 */
export const TTL_MS = 15000;
const caches = new WeakMap(); // store -> { ids:Set, at, generation, pending }
let generation = 0;

export const SUSPENDED_MESSAGE = 'This organization is suspended.';

/** Call after changing Organization.suspendedAt. */
export function forgetSuspendedOrgs() {
  generation++;
}

export async function suspendedOrgIds(store, now = Date.now()) {
  const cached = caches.get(store);
  if (cached && cached.generation === generation && now - cached.at < TTL_MS) return cached.ids;
  if (cached?.pending && cached.generation === generation) return cached.pending;
  const entry = { ids: cached?.ids ?? new Set(), at: 0, generation };
  entry.pending = store.client.organization
    .findMany({ where: { suspendedAt: { not: null } }, select: { id: true } })
    .then((rows) => {
      entry.ids = new Set(rows.map((r) => r.id));
      entry.at = Date.now();
      return entry.ids;
    })
    .finally(() => {
      entry.pending = null;
    });
  caches.set(store, entry);
  return entry.pending;
}

export async function isOrgSuspended(store, orgId) {
  if (!orgId) return false;
  return (await suspendedOrgIds(store)).has(orgId);
}

/** Org API (session) requests: 423 Locked. */
export async function assertOrgUnlocked(store, orgId) {
  if (await isOrgSuspended(store, orgId))
    throw new HttpError(423, SUSPENDED_MESSAGE, { code: 'org_suspended' });
}

/** Agent /v1 requests (ingest, config, register, prom write, logs): 403. */
export async function assertOrgActive(store, orgId) {
  if (await isOrgSuspended(store, orgId))
    throw new HttpError(403, SUSPENDED_MESSAGE, { code: 'org_suspended' });
}
