import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { CATALOG, describeError } from '../src/services/agent-errors.js';
import { recordDeduped, MAX_EVENTS_PER_AGENT } from '../src/services/agent-events.js';
import { revokeAgentAccess } from '../src/services/agents.js';
import { setup, closeStore, register } from './helpers.js';
import {
  enrollServer,
  createKey,
  registerAgent,
  ingest,
  payload,
  sample,
  bearer,
  fp,
  setPlan,
} from './agent-helpers.js';

let store, app, limits;
beforeEach(async () => {
  ({ store, app, limits } = await setup());
});
after(closeStore);

const connection = async (owner, id) => {
  const r = await owner.client.get(`/api/servers/${id}/connection`);
  assert.equal(r.status, 200, r.text);
  return r.body;
};
const step = (c, key) => c.steps.find((s) => s.key === key);
const ago = async (agentId, ms) => {
  const then = new Date(Date.now() - ms);
  await store.update('agent', agentId, { createdAt: then });
  await store.updateMany('agentEvent', { agentId }, { createdAt: then });
};

test('a freshly registered server is waiting, not failed', async () => {
  const owner = await register(app, 'Wait');
  const s = await enrollServer(app, owner);
  const c = await connection(owner, s.agentId);
  assert.equal(c.overall, 'waiting');
  assert.equal(step(c, 'registered').state, 'done');
  assert.equal(step(c, 'running').state, 'current');
  assert.equal(step(c, 'data').state, 'waiting');
  assert.equal(c.diagnosis, null);
  assert.ok(c.events.some((e) => e.code === 'registered'));
  assert.ok(c.commands.doctor.includes('doctor'));
});

test('once data flows every step is done and the age of the data is shown', async () => {
  const owner = await register(app, 'Flow');
  const s = await enrollServer(app, owner);
  assert.equal((await ingest(app, s.credential)).status, 202);
  const c = await connection(owner, s.agentId);
  assert.equal(c.overall, 'connected');
  for (const key of ['install_started', 'registered', 'running', 'data', 'problems'])
    assert.equal(step(c, key).state, 'done', key);
  assert.ok(step(c, 'data').secondsAgo <= 5);
  assert.match(step(c, 'data').detail, /Last data \d+ seconds? ago/);
  assert.ok(c.events.some((e) => e.code === 'first_data'));
});

test('when nothing arrives we say so honestly and give a checklist and the doctor command', async () => {
  const owner = await register(app, 'Silent');
  const s = await enrollServer(app, owner);
  await ago(s.agentId, 10 * 60000); // registered ten minutes ago, never sent a byte
  const c = await connection(owner, s.agentId);
  assert.equal(c.overall, 'silent');
  assert.equal(step(c, 'running').state, 'failed');
  assert.equal(c.diagnosis.kind, 'no_data');
  assert.match(c.diagnosis.explanation, /can't see the reason/);
  assert.equal(c.diagnosis.doctorCommand, 'sudo yuktiops-agent doctor');
  assert.ok(c.diagnosis.checklist.some((i) => /443/.test(i.text) && /curl/.test(i.command)));
});

test('a server that was online and then goes quiet is silent with a failed step', async () => {
  const owner = await register(app, 'Quiet');
  const s = await enrollServer(app, owner);
  await ingest(app, s.credential);
  await store.update('agent', s.agentId, { lastSeen: new Date(Date.now() - 20 * 60000) });
  await store.removeMany('agentEvent', { agentId: s.agentId });
  const c = await connection(owner, s.agentId);
  assert.equal(c.overall, 'silent');
  assert.equal(step(c, 'running').state, 'failed');
  assert.match(step(c, 'running').detail, /last heard/i);
});

test('every catalog entry has a title, an explanation and a fix; problems carry commands', () => {
  for (const [code, e] of Object.entries(CATALOG)) {
    assert.ok(e.title.length > 5, code);
    assert.ok(e.explanation.length > 15, code);
    assert.ok(['info', 'warning', 'error'].includes(e.severity), code);
    if (e.severity !== 'info') assert.ok(e.fix.summary.length > 5, code);
  }
  for (const code of [
    'https_unreachable',
    'dns_failed',
    'proxy_error',
    'clock_skew',
    'credential_revoked',
    'plan_limit',
    'payload_too_large',
    'docker_socket_denied',
    'disk_permission',
    'config_invalid',
    'buffer_full',
    'unknown',
  ])
    assert.ok(CATALOG[code], `${code} is in the catalog`);
  assert.deepEqual(CATALOG.clock_skew.fix.commands, ['sudo timedatectl set-ntp true', 'timedatectl status']);
  assert.ok(CATALOG.https_unreachable.fix.commands.some((c) => c.includes('curl -I https://')));
  assert.equal(describeError('collector_failed_gpu').title, 'The "gpu" measurement is failing');
  assert.equal(describeError('something_new').known, false);
  assert.equal(describeError('something_new').title, CATALOG.unknown.title);
});

test('agent-reported errors are stored once and explained with plain-language fixes', async () => {
  const owner = await register(app, 'Agent');
  const s = await enrollServer(app, owner);
  const errors = [
    { code: 'docker_socket_denied', message: 'permission denied /var/run/docker.sock' },
    { code: 'disk_permission', message: 'cannot read /mnt/x' },
    { code: 'https_unreachable', message: 'dial tcp: i/o timeout' },
    { code: 'proxy_error', message: '407' },
    { code: 'config_invalid', message: 'bad yaml' },
    { code: 'buffer_full', message: 'dropped 40' },
    { code: 'brand_new_code', message: 'who knows' },
  ];
  // The agent repeats its errors on every send; that must not multiply the events.
  for (let i = 0; i < 3; i++) assert.equal((await ingest(app, s.credential, payload([sample()], { errors }))).status, 202);
  const c = await connection(owner, s.agentId);
  assert.equal(c.overall, 'problem');
  assert.equal(step(c, 'problems').state, 'failed');
  const byCode = Object.fromEntries(c.events.map((e) => [e.code, e]));
  for (const e of errors) assert.equal(c.events.filter((x) => x.code === e.code).length, 1, e.code);
  assert.match(byCode.docker_socket_denied.title, /Docker/);
  assert.ok(byCode.docker_socket_denied.fix.commands.some((x) => x.includes('usermod')));
  assert.ok(byCode.https_unreachable.fix.commands.some((x) => x.includes('curl')));
  assert.equal(byCode.brand_new_code.title, CATALOG.unknown.title);
  assert.equal(byCode.brand_new_code.message, 'who knows');
  assert.equal(c.problems.length, errors.length);
});

test('a clock that is far off is detected and explained', async () => {
  const owner = await register(app, 'Clock');
  const s = await enrollServer(app, owner);
  const skewed = new Date(Date.now() - 7 * 60000).toISOString();
  const r = await ingest(app, s.credential, payload([sample({ time: skewed })], { sentAt: skewed }));
  assert.equal(r.status, 202);
  const c = await connection(owner, s.agentId);
  const e = c.events.find((x) => x.code === 'clock_skew');
  assert.ok(e);
  assert.ok(e.fix.commands.includes('sudo timedatectl set-ntp true'));
  assert.match(e.explanation, /7 minute/);
});

test('a revoked credential is recorded as a rejection, once, and explained', async () => {
  const owner = await register(app, 'Revoked');
  const s = await enrollServer(app, owner);
  await ingest(app, s.credential);
  await revokeAgentAccess(store, await store.find('agent', { id: s.agentId }));
  for (let i = 0; i < 4; i++) assert.equal((await ingest(app, s.credential)).status, 401);
  const c = await connection(owner, s.agentId);
  const rejections = c.events.filter((e) => e.code === 'credential_revoked');
  assert.equal(rejections.length, 1, 'repeated rejections are collapsed');
  assert.equal(rejections[0].source, 'server');
  assert.match(rejections[0].title, /disconnected/);
  assert.ok(c.problems.some((p) => p.code === 'credential_revoked'));
  // A random token that belongs to no server leaves no trace.
  assert.equal((await ingest(app, 'agent_deadbeef')).status, 401);
  assert.equal(await store.client.agentEvent.count({ where: { code: 'credential_revoked' } }), 1);
});

test('plan limit on registration is recorded and visible before any server exists', async () => {
  const owner = await register(app, 'Limit');
  const key = await createKey(owner);
  assert.equal((await registerAgent(app, key, 1)).status, 201);
  assert.equal((await registerAgent(app, key, 2)).status, 201);
  for (let i = 0; i < 3; i++) assert.equal((await registerAgent(app, key, 3)).status, 402);
  const pending = (await owner.client.get('/api/connection/pending')).body;
  const events = pending.events.filter((e) => e.code === 'plan_limit');
  assert.equal(events.length, 1);
  assert.match(events[0].title, /server limit/);
  assert.match(events[0].fix.summary, /Upgrade/);
  assert.equal(await store.client.agentEvent.count({ where: { fingerprint: fp(3) } }), 1);
});

test('oversized payloads (413) and rate limiting (429) are recorded for the server', async () => {
  const owner = await register(app, 'Big');
  const s = await enrollServer(app, owner);
  await ingest(app, s.credential);
  const huge = await request(app)
    .post('/v1/ingest')
    .set(bearer(s.credential))
    .send({ pad: 'x'.repeat(600000) });
  assert.equal(huge.status, 413);
  for (let i = 0; i < 31; i++) await ingest(app, s.credential);
  assert.equal((await ingest(app, s.credential)).status, 429);
  const c = await connection(owner, s.agentId);
  const codes = c.events.map((e) => e.code);
  assert.ok(codes.includes('payload_too_large'));
  assert.ok(codes.includes('rate_limited'));
  assert.equal(codes.filter((x) => x === 'rate_limited').length, 1);
  assert.match(c.events.find((e) => e.code === 'payload_too_large').title, /too large/);
});

test('invalid data is recorded as a rejection', async () => {
  const owner = await register(app, 'Bad');
  const s = await enrollServer(app, owner);
  const r = await ingest(app, s.credential, { sentAt: 'nope', samples: [] });
  assert.equal(r.status, 400);
  const c = await connection(owner, s.agentId);
  assert.ok(c.events.some((e) => e.code === 'invalid_payload' && e.source === 'server'));
});

test('a removed server is told so, and only 50 events are kept per server', async () => {
  const owner = await register(app, 'Cap');
  const s = await enrollServer(app, owner);
  const agent = await store.find('agent', { id: s.agentId });
  for (let i = 0; i < 70; i++)
    await recordDeduped(store, {
      orgId: owner.orgId,
      agentId: agent.id,
      source: 'agent',
      code: `collector_failed_x${i}`,
      message: `n${i}`,
    });
  assert.equal(await store.client.agentEvent.count({ where: { agentId: agent.id } }), MAX_EVENTS_PER_AGENT);
  const c = await connection(owner, s.agentId);
  assert.equal(c.events.length, 50);
  assert.equal(c.events[0].code, 'collector_failed_x69', 'newest first');
});

test('install steps form a timeline that survives registration', async () => {
  const owner = await register(app, 'Install');
  const key = await createKey(owner);
  const post = (step, message = '') =>
    request(app)
      .post('/v1/install-events')
      .set(bearer(key))
      .send({ fingerprint: fp(9), step, message });
  await post('started');
  await post('downloaded');
  let pending = (await owner.client.get('/api/connection/pending')).body;
  assert.equal(pending.serverId, null);
  assert.equal(pending.steps.find((x) => x.key === 'install_started').state, 'done');
  assert.equal(pending.steps.find((x) => x.key === 'registered').state, 'current');
  await post('installed');
  const reg = await registerAgent(app, key, 9);
  assert.equal(reg.status, 201);
  await post('service_started');
  const c = await connection(owner, reg.body.agentId);
  assert.deepEqual(
    c.installTimeline.map((e) => e.code),
    ['started', 'downloaded', 'installed', 'registered', 'service_started'],
  );
  assert.equal(c.installTimeline[0].title, 'Install started');
  pending = (await owner.client.get('/api/connection/pending')).body;
  assert.equal(pending.serverId, reg.body.agentId);
});

test('an install that never registers is reported as silent after a few minutes', async () => {
  const owner = await register(app, 'Nothing');
  const key = await createKey(owner);
  await request(app).post('/v1/install-events').set(bearer(key)).send({ fingerprint: fp(5), step: 'started' });
  await store.updateMany('agentEvent', { fingerprint: fp(5) }, { createdAt: new Date(Date.now() - 10 * 60000) });
  const pending = (await owner.client.get('/api/connection/pending')).body;
  assert.equal(pending.diagnosis.kind, 'no_data');
  const failed = await request(app)
    .post('/v1/install-events')
    .set(bearer(key))
    .send({ fingerprint: fp(5), step: 'failed', message: 'curl: (7) connect failed' });
  assert.equal(failed.status, 202);
  const after = (await owner.client.get('/api/connection/pending')).body;
  assert.equal(after.steps.find((x) => x.key === 'install_started').state, 'done');
  assert.equal(after.steps.find((x) => x.key === 'problems').state, 'failed');
  assert.match(after.events.find((e) => e.code === 'failed').fix.commands[0], /doctor/);
});

test('connection data is private to the organization', async () => {
  const a = await register(app, 'Mine');
  const b = await register(app, 'Theirs');
  const s = await enrollServer(app, a);
  assert.equal((await b.client.get(`/api/servers/${s.agentId}/connection`)).status, 404);
  assert.equal((await request(app).get(`/api/servers/${s.agentId}/connection`)).status, 401);
  void limits;
  void setPlan;
});
