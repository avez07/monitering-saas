import { assert } from '../lib/errors.js';
import { token, digest } from '../lib/crypto.js';
import { enforceCount } from './limits.js';
import { configForAgent } from './agent-config.js';

/** Cut one server off: revoke every credential it holds and mark it and its record unhealthy. */
export async function revokeAgentAccess(store, agent) {
  const now = new Date();
  await store.updateMany(
    'agentCredential',
    { agentId: agent.id, revokedAt: null },
    { revokedAt: now },
  );
  await store.update('agent', agent.id, { status: 'revoked' });
  await store.updateMany('monitoredResource', { agentId: agent.id }, { status: 'unhealthy' });
}

/** Every server in the organization loses access (used when the API key is revoked with "disconnect"). */
export async function revokeAllAgents(store, orgId) {
  let count = 0;
  for (const agent of await store.list('agent', { orgId })) {
    if (agent.status === 'revoked') continue;
    await revokeAgentAccess(store, agent);
    count++;
  }
  return count;
}

const defaultProject = async (store, orgId) => {
  const projects = (await store.list('project', { orgId }))
    .filter((p) => !p.deletedAt)
    .sort((a, b) => a.createdAt - b.createdAt);
  assert(projects.length, 409, 'This organization has no project to add servers to.');
  return projects[0];
};

async function registerOnce(tx, key, input) {
  const { orgId } = key;
  let setup = null;
  if (input.setupId) {
    setup = await tx.find('agentConfig', { id: input.setupId, orgId });
    assert(
      setup,
      404,
      'Setup profile not found. Copy the install command from your dashboard again.',
    );
  }
  const raw = token('agent');
  const fields = {
    platform: input.platform,
    os: input.os,
    arch: input.arch,
    version: input.version,
    status: 'pending',
    lastSeen: new Date(),
    ...(setup ? { configId: setup.id, kind: setup.settings?.hostKind || 'server' } : {}),
  };
  let agent = await tx.find('agent', { orgId, fingerprint: input.fingerprint });
  let reconnected = false;
  if (agent) {
    // Same machine again: reconnect the same server and replace its credential.
    reconnected = true;
    await tx.updateMany(
      'agentCredential',
      { agentId: agent.id, revokedAt: null },
      { revokedAt: new Date() },
    );
    agent = await tx.update('agent', agent.id, fields);
    const resource = await tx.find('monitoredResource', { agentId: agent.id, type: 'server' });
    if (resource?.deletedAt) await countAgainstPlan(tx, orgId);
    if (resource)
      await tx.update('monitoredResource', resource.id, { status: 'pending', deletedAt: null });
  } else {
    await countAgainstPlan(tx, orgId);
    const project = await defaultProject(tx, orgId);
    agent = await tx.create('agent', {
      orgId,
      projectId: project.id,
      name: input.name,
      fingerprint: input.fingerprint,
      ...fields,
    });
    await tx.create('monitoredResource', {
      orgId,
      projectId: project.id,
      agentId: agent.id,
      name: input.name,
      type: 'server',
      environment: 'production',
      status: 'pending',
      labels: {},
    });
  }
  await tx.create('agentCredential', {
    orgId,
    projectId: agent.projectId,
    agentId: agent.id,
    kind: 'agent',
    name: agent.name,
    prefix: raw.slice(0, 14),
    tokenHash: digest(raw),
  });
  // Install steps reported before this machine had an identity now belong to it.
  await tx.updateMany(
    'agentEvent',
    { orgId, fingerprint: input.fingerprint, agentId: null },
    { agentId: agent.id },
  );
  return { agent, credential: raw, reconnected, config: await configForAgent(tx, agent) };
}

async function countAgainstPlan(tx, orgId) {
  const servers = (await tx.list('monitoredResource', { orgId, type: 'server' })).filter(
    (r) => !r.deletedAt,
  );
  await enforceCount(tx, orgId, 'servers', servers.length);
}

/**
 * Exchange the account API key for this server's own credential. Registering the same machine twice
 * returns the same server, and the plan's server limit is checked atomically.
 */
export async function registerServer(store, key, input) {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await store.transaction((tx) => registerOnce(tx, key, input));
      try {
        const { touchLastSeen } = await import('../queues/ingest.js');
        await touchLastSeen(result.agent.id, Date.now());
      } catch {
        /* Redis hiccup: the offline sweep falls back to the database */
      }
      return result;
    } catch (error) {
      // Two installs racing (same machine, or both taking the last free slot): retry on the new state.
      if (attempt < 5 && ['P2002', 'P2034'].includes(error.code)) continue;
      throw error;
    }
  }
}
