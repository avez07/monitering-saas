import request from 'supertest';
import { digest } from '../src/lib/crypto.js';
import { drainIngest } from './helpers.js';

export const fp = (n) => digest(`b1-machine-${n}`);
export const bearer = (value) => ({ Authorization: `Bearer ${value}` });

export async function createKey(owner) {
  const response = await owner.client.post('/api/api-key');
  if (response.status !== 201) throw new Error(`api key failed: ${response.status} ${response.text}`);
  return response.body.key;
}

export const registerAgent = (app, key, n, extra = {}) =>
  request(app)
    .post('/v1/register')
    .set(bearer(key))
    .send({
      name: `host-${n}`,
      fingerprint: fp(n),
      platform: 'linux',
      os: 'Ubuntu 24.04',
      arch: 'amd64',
      version: '0.1.0',
      ...extra,
    });

/** Create a key (if needed) and register one server; returns { key, agentId, credential }. */
export async function enrollServer(app, owner, n = 1, key = null) {
  key ||= await createKey(owner);
  const response = await registerAgent(app, key, n);
  if (![200, 201].includes(response.status))
    throw new Error(`register failed: ${response.status} ${response.text}`);
  return { key, agentId: response.body.agentId, credential: response.body.credential };
}

export const sample = (over = {}) => ({
  time: new Date().toISOString(),
  cpu: 12,
  memory: 25,
  disk: 18,
  load: [0.1, 0.2, 0.3],
  uptimeSeconds: 100,
  netRxBps: 1000,
  netTxBps: 500,
  details: {
    mounts: [{ path: '/', percent: 18, totalBytes: 1e11, usedBytes: 1.8e10 }],
    interfaces: [{ name: 'eth0', rxBps: 1000, txBps: 500 }],
    processes: [{ name: 'node', pid: 42, cpu: 3.2, memBytes: 1e8 }],
  },
  ...over,
});
export const payload = (samples = [sample()], extra = {}) => ({
  sentAt: new Date().toISOString(),
  agent: { version: '0.1.0', os: 'Linux', arch: 'amd64', cores: 4, ramBytes: 16 * 1024 ** 3 },
  samples,
  errors: [],
  ...extra,
});
/** POST /v1/ingest exactly as an agent would; nothing is stored until a worker runs (see drainIngest). */
export const ingestRaw = (app, credential, body = payload()) =>
  request(app).post('/v1/ingest').set(bearer(credential)).send(body);
/** Like ingestRaw, but when the report was accepted (202) the workers drain it before returning. */
export async function ingest(app, credential, body = payload()) {
  const response = await ingestRaw(app, credential, body);
  if (response.status === 202) await drainIngest();
  return response;
}

export async function setPlan(store, owner, planId) {
  const subscription = await store.find('subscription', { orgId: owner.orgId });
  await store.update('subscription', subscription.id, { planId });
}
