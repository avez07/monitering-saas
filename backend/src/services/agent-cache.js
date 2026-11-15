import { assert } from '../lib/errors.js';
import { digest } from '../lib/crypto.js';
import { configForAgent } from './agent-config.js';

/**
 * Short-lived, in-memory copy of what an ingest request needs to know about one agent: its credential,
 * server record, resource and setup profile. Agents report every 15-300 seconds, so without this each
 * report re-reads the same five rows.
 *
 * Staleness is bounded two ways. Any write through the store to a table listed in WATCHED (revoking a
 * credential, deleting a server, editing a setup profile, ...) bumps `epoch`, which invalidates every
 * entry at once; and entries expire after TTL_MS in case another process made the change. The ingest
 * route's own writes bypass the epoch (they use `store.client` directly) so reports do not evict the cache.
 */
export const TTL_MS = 120000;
const MAX_ENTRIES = 20000;
export const WATCHED = new Set([
  'agent',
  'agentCredential',
  'monitoredResource',
  'agentConfig',
  'project',
]);
const state = { epoch: 0 };
export const bumpAgentCache = () => void state.epoch++;
const entries = new Map();

export async function loadAgentContext(store, rawToken, now = Date.now()) {
  assert(rawToken, 401, 'An agent credential is required.');
  const tokenHash = digest(rawToken);
  const hit = entries.get(tokenHash);
  if (hit && hit.epoch === state.epoch && now - hit.at < TTL_MS) return hit;
  entries.delete(tokenHash);
  const epoch = state.epoch;
  const credential = await store.find('agentCredential', { tokenHash });
  assert(
    credential &&
      !credential.revokedAt &&
      (!credential.expiresAt || new Date(credential.expiresAt) > new Date()),
    401,
    'Invalid or revoked agent credential.',
  );
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
  if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value);
  entries.set(tokenHash, entry);
  return entry;
}

/** The entry is only trusted while its credential has not expired in the meantime. */
export const stillValid = (entry, now = Date.now()) => !entry.expiresAt || entry.expiresAt > now;
