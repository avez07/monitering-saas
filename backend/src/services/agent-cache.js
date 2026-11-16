import { assert } from '../lib/errors.js';
import { digest } from '../lib/crypto.js';
import { configForAgent } from './agent-config.js';
import { CHANNELS, createSubscriber, getRedis, redisUrl } from '../lib/redis.js';

/**
 * Short-lived copy of what an ingest request needs to know about one agent: its credential, server
 * record, resource and setup profile. Agents report every 15-300 seconds, so without this each report
 * re-reads the same five rows.
 *
 * The entries live in each API process (they hold Dates and a mutable `wrote` marker), but their
 * validity is coordinated through Redis so every instance agrees:
 *  - `yk:agent:epoch` is bumped by every store write to a WATCHED table; an entry loaded under an older
 *    epoch is discarded. It is read on every request together with the revocation key (one MGET).
 *  - `yk:revoked:<credId>` is written when a credential is revoked and checked on every request, so a
 *    revoke is effective on all instances immediately, even if the cache was refilled concurrently.
 *  - `yk:agent:invalidate` pub/sub (`<agentId>` or `*`) makes other instances drop entries eagerly.
 * Entries also expire after TTL_MS. The ingest route's own writes use `store.client` directly and do
 * not touch the epoch, so reports do not evict the cache.
 */
export const TTL_MS = 120000;
const MAX_ENTRIES = 20000;
const REVOKED_TTL_SECONDS = 86400; // far longer than any cached entry can live
export const WATCHED = new Set([
  'agent',
  'agentCredential',
  'monitoredResource',
  'agentConfig',
  'project',
]);
const EPOCH_KEY = 'agent:epoch';
const revokedKey = (credentialId) => `revoked:${credentialId}`;

/** Per-store cache (one per API instance; several can exist in one process, e.g. in tests). */
class AgentCache {
  constructor() {
    this.entries = new Map(); // tokenHash -> entry
  }
  drop(agentId) {
    if (agentId === '*') return void this.entries.clear();
    for (const [hash, entry] of this.entries) if (entry.agent.id === agentId) this.entries.delete(hash);
  }
}
const caches = new WeakMap(); // store -> AgentCache
const live = new Set(); // every AgentCache that should hear pub/sub messages
let subscriber = null;
let subscribedUrl = null;
function ensureSubscriber() {
  const url = redisUrl();
  if (subscriber && subscribedUrl === url) return;
  subscriber?.disconnect();
  subscribedUrl = url;
  subscriber = createSubscriber(url);
  subscriber.on('message', (channel, message) => {
    if (channel === CHANNELS.agentInvalidate) for (const cache of live) cache.drop(message);
  });
  subscriber.subscribe(CHANNELS.agentInvalidate).catch(() => {});
}
function cacheFor(store) {
  let cache = caches.get(store);
  if (!cache) {
    caches.set(store, (cache = new AgentCache()));
    live.add(cache);
    ensureSubscriber();
  }
  return cache;
}

/**
 * Called by the store around writes to WATCHED tables. Bumps the epoch, optionally marks credentials
 * revoked, and tells the other instances. `target` is an agent id or '*'.
 */
export async function invalidateAgents(target = '*', { revokedCredentialIds = [] } = {}) {
  const redis = getRedis();
  const pipeline = redis.multi().incr(EPOCH_KEY);
  for (const id of revokedCredentialIds) pipeline.set(revokedKey(id), '1', 'EX', REVOKED_TTL_SECONDS);
  await pipeline.exec();
  await redis.publish(CHANNELS.agentInvalidate, target);
}

/** Drop this process's entries (tests that reset state). */
export function resetAgentCache(store) {
  if (store) caches.get(store)?.entries.clear();
  else for (const cache of live) cache.entries.clear();
}
/** Stop listening (end of tests / shutdown). */
export async function closeAgentCache() {
  const current = subscriber;
  subscriber = null;
  subscribedUrl = null;
  live.clear();
  if (current) await current.quit().catch(() => current.disconnect());
}

async function revocationState(credentialId) {
  const keys = credentialId ? [EPOCH_KEY, revokedKey(credentialId)] : [EPOCH_KEY];
  const [epoch, revoked] = await getRedis().mget(keys);
  return { epoch: epoch || '0', revoked: Boolean(revoked) };
}

export async function loadAgentContext(store, rawToken, now = Date.now()) {
  assert(rawToken, 401, 'An agent credential is required.');
  const cache = cacheFor(store);
  const tokenHash = digest(rawToken);
  const hit = cache.entries.get(tokenHash);
  if (hit) {
    const state = await revocationState(hit.credential.id);
    assert(!state.revoked, 401, 'Invalid or revoked agent credential.');
    if (hit.epoch === state.epoch && now - hit.at < TTL_MS) return hit;
    cache.entries.delete(tokenHash);
  }
  const { epoch } = await revocationState(null);
  const credential = await store.find('agentCredential', { tokenHash });
  assert(
    credential &&
      !credential.revokedAt &&
      (!credential.expiresAt || new Date(credential.expiresAt) > new Date()),
    401,
    'Invalid or revoked agent credential.',
  );
  assert(!(await revocationState(credential.id)).revoked, 401, 'Invalid or revoked agent credential.');
  const project = await store.find('project', {
    id: credential.projectId,
    orgId: credential.orgId,
  });
  assert(project && !project.deletedAt, 403, 'Project is unavailable.');
  assert(credential.agentId, 403, 'This credential cannot be used by an agent.');
  const agent = await store.find('agent', { id: credential.agentId });
  assert(agent && agent.status !== 'revoked', 401, 'This server has been disconnected.');
  const resource = await store.find('monitoredResource', { agentId: agent.id, type: 'server' });
  const setup = await configForAgent(store, agent);
  const entry = {
    at: now,
    epoch,
    expiresAt: credential.expiresAt ? new Date(credential.expiresAt).getTime() : null,
    credential,
    agent,
    resource,
    setup,
    // What the last ingest wrote, so identical follow-ups can skip the UPDATE.
    wrote: { agentAt: 0, resourceAt: 0, agentSig: '', resourceSig: '' },
  };
  if (cache.entries.size >= MAX_ENTRIES) cache.entries.delete(cache.entries.keys().next().value);
  cache.entries.set(tokenHash, entry);
  return entry;
}

/** The entry is only trusted while its credential has not expired in the meantime. */
export const stillValid = (entry, now = Date.now()) => !entry.expiresAt || entry.expiresAt > now;
