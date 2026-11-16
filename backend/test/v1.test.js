import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import request from 'supertest';
import { digest } from '../src/lib/crypto.js';
import { insertSamples, trimRawMetricsByPlan } from '../src/services/metrics.js';
import { setup, closeStore, register, addMember, drainIngest } from './helpers.js';

let store, app;
beforeEach(async () => {
  ({ store, app } = await setup());
});
after(closeStore);

const fp = (n) => digest(`machine-${n}`);
const bearer = (value) => ({ Authorization: `Bearer ${value}` });
async function createKey(owner) {
  const response = await owner.client.post('/api/api-key');
  assert.equal(response.status, 201, response.text);
  return response.body.key;
}
const enroll = (key, n, extra = {}) =>
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
const sample = (over = {}) => ({
  time: new Date().toISOString(),
  cpu: 12,
  memory: 25,
  disk: 18,
  load: [0.1, 0.2, 0.3],
  uptimeSeconds: 100,
  ...over,
});
const body = (samples = [sample()], extra = {}) => ({
  sentAt: new Date().toISOString(),
  agent: { version: '0.1.0', os: 'Linux', arch: 'amd64', cores: 4, ramBytes: 16 * 1024 ** 3 },
  samples,
  errors: [],
  ...extra,
});
const ingestRaw = (credential, payload = body()) =>
  request(app).post('/v1/ingest').set(bearer(credential)).send(payload);
/** Accepted reports (202) are drained by the in-process worker before the test looks at the database. */
const ingest = async (credential, payload = body()) => {
  const response = await ingestRaw(credential, payload);
  if (response.status === 202) await drainIngest();
  return response;
};
const upgrade = async (owner, planId) => {
  const subscription = await store.find('subscription', { orgId: owner.orgId });
  await store.update('subscription', subscription.id, { planId });
};
const metricRows = (agentId) => store.client.serverMetric.findMany({ where: { agentId } });

test('the account API key is shown once, stored hashed, and can be regenerated and revoked', async () => {
  const owner = await register(app, 'Keys');
  assert.deepEqual((await owner.client.get('/api/api-key')).body, { key: null });
  const created = await owner.client.post('/api/api-key');
  assert.equal(created.status, 201);
  assert.match(created.body.key, /^yk_live_[a-f0-9]{64}$/);
  assert.equal(created.body.prefix, created.body.key.slice(0, 12));
  assert.equal((await owner.client.post('/api/api-key')).status, 409, 'only one active key');

  const shown = await owner.client.get('/api/api-key');
  assert.equal(shown.body.key.prefix, created.body.prefix);
  assert.ok(!JSON.stringify(shown.body).includes(created.body.key), 'the key cannot be read back');
  const [row] = await store.list('apiKey', { orgId: owner.orgId });
  assert.equal(row.tokenHash, digest(created.body.key));
  assert.ok(!JSON.stringify(row).includes(created.body.key));

  const first = created.body.key;
  assert.equal((await enroll(first, 1)).status, 201);
  const regenerated = await owner.client.post('/api/api-key/regenerate');
  assert.equal(regenerated.status, 201);
  assert.notEqual(regenerated.body.key, first);
  assert.equal((await enroll(first, 2)).status, 401, 'the old key stops working for new installs');
  assert.equal((await enroll(regenerated.body.key, 2)).status, 201);
  assert.equal((await store.list('apiKey', { orgId: owner.orgId, revokedAt: null })).length, 1);

  const revoked = await owner.client.delete('/api/api-key');
  assert.deepEqual(revoked.body, { revoked: true, disconnected: 0 });
  assert.equal((await enroll(regenerated.body.key, 3)).status, 401);
  assert.equal((await owner.client.delete('/api/api-key')).status, 404);
  assert.deepEqual((await owner.client.get('/api/api-key')).body, { key: null });
});

test('regenerating or revoking the key leaves connected servers running unless asked to disconnect them', async () => {
  const owner = await register(app, 'Keep');
  const key = await createKey(owner);
  const server = (await enroll(key, 1)).body;
  await owner.client.post('/api/api-key/regenerate');
  assert.equal((await ingest(server.credential)).status, 202, 'existing servers keep reporting');
  await owner.client.delete('/api/api-key');
  assert.equal((await ingest(server.credential)).status, 202, 'revoking alone does not disconnect');

  const next = (await owner.client.post('/api/api-key')).body.key;
  const second = (await enroll(next, 2)).body;
  const result = await owner.client.delete('/api/api-key?disconnectServers=true');
  assert.equal(result.body.disconnected, 2);
  assert.equal((await ingest(server.credential)).status, 401);
  assert.equal((await ingest(second.credential)).status, 401);
});

test('only administrators of the organization manage the key, and keys never cross organizations', async () => {
  const a = await register(app, 'Alpha');
  const b = await register(app, 'Beta');
  const viewer = await addMember(app, store, a, { role: 'viewer' });
  const restricted = await addMember(app, store, a, { role: 'viewer' });
  assert.equal((await viewer.client.post('/api/api-key')).status, 403);
  assert.equal((await restricted.client.post('/api/api-key')).status, 403);
  const keyA = await createKey(a);
  const keyB = await createKey(b);
  assert.notEqual(keyA, keyB);
  const server = (await enroll(keyA, 1)).body;
  assert.equal((await store.find('agent', { id: server.agentId })).orgId, a.orgId);
  assert.equal((await b.client.get('/api/agents')).body.length, 0);
  assert.equal((await a.client.get('/api/agents')).body.length, 1);
  assert.equal(
    (await request(app).get('/api/api-key')).status,
    401,
    'signed-out callers are refused',
  );
});

test('one key registers several servers; the plan limit is enforced even for simultaneous installs', async () => {
  const owner = await register(app, 'Many');
  const key = await createKey(owner);
  const results = await Promise.all([1, 2, 3].map((n) => enroll(key, n)));
  assert.deepEqual(
    results.map((r) => r.status).sort(),
    [201, 201, 402],
    'free plan includes 2 servers',
  );
  assert.equal((await store.list('agent', { orgId: owner.orgId })).length, 2);
  await upgrade(owner, 'starter');
  // Whichever install lost the race can now be retried; machines that already registered just reconnect.
  const retried = [];
  for (const n of [1, 2, 3, 4]) retried.push((await enroll(key, n)).status);
  assert.deepEqual(retried.map((s) => s).sort(), [200, 200, 201, 201]);
  const resources = (await store.list('monitoredResource', { orgId: owner.orgId })).filter(
    (r) => r.type === 'server',
  );
  assert.equal(resources.length, 4);
  assert.ok(resources.every((r) => r.projectId === owner.project.id));
});

test('registering the same machine again reconnects the same server and replaces its credential', async () => {
  const owner = await register(app, 'Again');
  const key = await createKey(owner);
  const first = await enroll(key, 1);
  assert.equal(first.status, 201);
  assert.equal(first.body.reconnected, false);
  const second = await enroll(key, 1, { name: 'renamed-host' });
  assert.equal(second.status, 200);
  assert.equal(second.body.reconnected, true);
  assert.equal(second.body.agentId, first.body.agentId);
  assert.equal((await store.list('agent', { orgId: owner.orgId })).length, 1);
  assert.equal(
    (await store.list('monitoredResource', { orgId: owner.orgId, type: 'server' })).length,
    1,
  );
  assert.equal((await ingest(first.body.credential)).status, 401, 'the old credential is replaced');
  assert.equal((await ingest(second.body.credential)).status, 202);

  // Several installs of one machine at once still leave one server and one working credential.
  await Promise.all([1, 2, 3].map(() => enroll(key, 1)));
  assert.equal((await store.list('agent', { orgId: owner.orgId })).length, 1);
  const live = await store.list('agentCredential', { orgId: owner.orgId, revokedAt: null });
  assert.equal(live.length, 1);
  // A removed server that is registered again counts against the plan once more.
  const resource = await store.find('monitoredResource', { orgId: owner.orgId, type: 'server' });
  await owner.client.delete(`/api/resources/${resource.id}`);
  assert.equal((await enroll(key, 1)).status, 200);
  assert.equal((await store.find('monitoredResource', { id: resource.id })).deletedAt, null);
});

test('registration validates its input and throttles repeated wrong keys', async () => {
  const owner = await register(app, 'Strict');
  const key = await createKey(owner);
  assert.equal((await request(app).post('/v1/register').send({})).status, 401);
  assert.equal((await enroll(key, 1, { fingerprint: 'not-a-hash' })).status, 400);
  assert.equal((await enroll(key, 1, { name: '' })).status, 400);
  assert.equal((await enroll(key, 1, { setupId: 'st_000000000000000000000000' })).status, 404);
  // Another organization's setup profile cannot be used.
  const other = await register(app, 'Other');
  const [theirs] = (await other.client.get('/api/agent-configs')).body;
  assert.equal((await enroll(key, 1, { setupId: theirs.id })).status, 404);
  assert.equal(
    (await store.list('agent', { orgId: owner.orgId })).length,
    0,
    'nothing half-created',
  );

  const wrong = 'yk_live_' + '0'.repeat(64);
  const statuses = [];
  for (let i = 0; i < 22; i++) statuses.push((await enroll(wrong, 1)).status);
  assert.equal(statuses[0], 401);
  assert.equal(statuses.at(-1), 429, 'guessing keys is throttled');
  assert.equal(
    (await enroll(key, 1)).status,
    429,
    'the throttle applies to the address, even for a real key',
  );
});

test('ingest needs a server credential, stores samples, and updates the server record', async () => {
  const owner = await register(app, 'Ingest');
  const key = await createKey(owner);
  const server = (await enroll(key, 1)).body;
  assert.equal((await request(app).post('/v1/ingest').send(body())).status, 401);
  assert.equal((await ingest(key)).status, 401, 'the account key cannot send data');
  assert.equal((await ingest('agent_' + 'a'.repeat(64))).status, 401);

  const first = await ingest(server.credential, body([sample({ cpu: 40, memory: 50, swap: 3 })]));
  assert.equal(first.status, 202, first.text);
  assert.equal(first.body.configVersion, server.config.version, 'the version the agent tracks');
  assert.ok(first.body.serverTime);
  const [row] = await metricRows(server.agentId);
  assert.equal(row.cpuPercent, 40);
  assert.equal(row.memPercent, 50);
  assert.equal(row.swapPercent, 3);
  assert.equal(row.load5, 0.2);
  assert.equal(row.orgId, owner.orgId);

  const agent = await store.find('agent', { id: server.agentId });
  assert.equal(agent.status, 'healthy');
  assert.equal(agent.os, 'Linux');
  const resource = await store.find('monitoredResource', { agentId: server.agentId });
  assert.equal(resource.status, 'healthy');
  assert.equal(resource.labels.cpu, 40);
  assert.equal(resource.labels.cores, 4);
  assert.equal(resource.labels.ramGb, 16);
  const events = await store.list('agentEvent', { agentId: server.agentId });
  assert.ok(events.some((e) => e.code === 'first_data'));

  const hot = await ingest(server.credential, body([sample({ cpu: 95 })]));
  assert.equal(hot.status, 202);
  assert.equal((await store.find('monitoredResource', { id: resource.id })).status, 'warning');
});

test('ingest accepts gzip, ignores re-sent batches, back-fills buffered samples and drops impossible ones', async () => {
  const owner = await register(app, 'Batch');
  const server = (await enroll(await createKey(owner), 1)).body;
  const now = Date.now();
  const at = (secondsAgo) => new Date(now - secondsAgo * 1000).toISOString();
  const payload = body([
    sample({ time: at(600), cpu: 10 }), // buffered during a 10-minute outage
    sample({ time: at(570), cpu: 11 }),
    sample({ time: at(60 * 40), cpu: 99 }), // older than the 30-minute window
    sample({ time: at(-3600), cpu: 98 }), // an hour in the future
  ]);
  const compressed = await request(app)
    .post('/v1/ingest')
    .set(bearer(server.credential))
    .set('Content-Type', 'application/json')
    .set('Content-Encoding', 'gzip')
    .serialize((data) => data) // superagent would otherwise JSON-encode the Buffer
    .send(gzipSync(JSON.stringify(payload)));
  assert.equal(compressed.status, 202, compressed.text);
  await drainIngest(); // 2 stored, 2 dropped (too old / too far ahead)
  const again = await ingest(server.credential, payload);
  assert.equal(again.status, 202, 're-sending the same batch adds nothing');
  assert.deepEqual(
    (await metricRows(server.agentId)).map((r) => r.cpuPercent).sort((a, b) => a - b),
    [10, 11],
  );
});

test('ingest rejects malformed and oversized bodies', async () => {
  const owner = await register(app, 'Bad');
  const server = (await enroll(await createKey(owner), 1)).body;
  assert.equal((await ingest(server.credential, body([sample({ cpu: 150 })]))).status, 400);
  assert.equal((await ingest(server.credential, body([]))).status, 400);
  assert.equal((await ingest(server.credential, { samples: [sample()] })).status, 400);
  const big = await ingest(server.credential, { ...body(), padding: 'x'.repeat(600 * 1024) });
  assert.equal(big.status, 413);
  const bomb = await request(app)
    .post('/v1/ingest')
    .set(bearer(server.credential))
    .set('Content-Type', 'application/json')
    .set('Content-Encoding', 'gzip')
    .serialize((data) => data)
    .send(gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x20)));
  assert.equal(bomb.status, 413, 'the size limit applies after decompression');
  assert.equal((await metricRows(server.agentId)).length, 0);
});

test('a wrong server clock is corrected and reported; agent errors are kept as events', async () => {
  const owner = await register(app, 'Clock');
  const server = (await enroll(await createKey(owner), 1)).body;
  const ahead = new Date(Date.now() + 10 * 60000).toISOString(); // agent clock 10 minutes fast
  const skewed = await ingest(
    server.credential,
    body([sample({ time: ahead })], {
      sentAt: ahead,
      errors: [{ code: 'disk_permission', message: 'cannot read /var' }],
    }),
  );
  assert.equal(skewed.status, 202);
  const [row] = await metricRows(server.agentId);
  assert.ok(Math.abs(row.time.getTime() - Date.now()) < 30000, 'stored on the server timeline');
  const events = await store.list('agentEvent', { agentId: server.agentId });
  const skew = events.find((e) => e.code === 'clock_skew');
  assert.equal(skew.source, 'server');
  assert.ok(skew.details.offsetSeconds < -500);
  assert.equal(events.find((e) => e.code === 'disk_permission').source, 'agent');
  // The skew warning is not repeated on every send.
  await ingest(server.credential, body([sample({ time: ahead })], { sentAt: ahead }));
  assert.equal(
    (await store.list('agentEvent', { agentId: server.agentId, code: 'clock_skew' })).length,
    1,
  );

  assert.equal(
    (await ingest(server.credential, body([sample()], { errors: [{ code: 'Bad Code!' }] }))).status,
    400,
  );
});

test('only the newest 50 events are kept for a server', async () => {
  const owner = await register(app, 'Events');
  const server = (await enroll(await createKey(owner), 1)).body;
  for (let batch = 0; batch < 3; batch++)
    await ingest(
      server.credential,
      body([sample()], {
        errors: Array.from({ length: 20 }, (_, i) => ({ code: `problem_${batch}_${i}` })),
      }),
    );
  const events = await store.list('agentEvent', { agentId: server.agentId });
  assert.equal(events.length, 50);
  assert.ok(
    events.some((e) => e.code === 'problem_2_19'),
    'the newest are the ones kept',
  );
  assert.ok(!events.some((e) => e.code === 'problem_0_0'));
});

test('a revoked, rotated or removed server is rejected immediately', async () => {
  const owner = await register(app, 'Cut');
  const key = await createKey(owner);
  const one = (await enroll(key, 1)).body;
  const two = (await enroll(key, 2)).body;
  assert.equal((await ingest(one.credential)).status, 202);

  await owner.client.post(`/api/agents/${one.agentId}/revoke`);
  assert.equal((await ingest(one.credential)).status, 401);
  assert.equal((await request(app).get('/v1/config').set(bearer(one.credential))).status, 401);
  assert.equal((await store.find('agent', { id: one.agentId })).status, 'revoked');
  assert.equal(
    (await store.find('monitoredResource', { agentId: one.agentId })).status,
    'unhealthy',
  );

  const rotated = await owner.client.post(`/api/agents/${two.agentId}/rotate`);
  assert.equal(rotated.status, 200);
  assert.equal((await ingest(two.credential)).status, 401);
  assert.equal((await ingest(rotated.body.token)).status, 202);

  // Deleting a server from the dashboard also stops its agent.
  const resource = await store.find('monitoredResource', { agentId: two.agentId });
  assert.equal((await owner.client.delete(`/api/resources/${resource.id}`)).status, 204);
  assert.equal((await ingest(rotated.body.token)).status, 401);
  // Only hashes are stored.
  for (const c of await store.list('agentCredential'))
    assert.ok(![one.credential, two.credential, rotated.body.token].includes(c.tokenHash));
});

test('setup profiles are created per organization, pulled by the agent, and validated', async () => {
  const owner = await register(app, 'Setup');
  const key = await createKey(owner);
  const profiles = await owner.client.get('/api/agent-configs');
  assert.equal(profiles.body.length, 1);
  const [standard] = profiles.body;
  assert.match(standard.id, /^st_[a-f0-9]{24}$/);
  assert.equal(standard.isDefault, true);
  assert.equal(standard.settings.sendIntervalSeconds, 30);
  assert.equal(standard.settings.collectors.processes, true);

  const server = (await enroll(key, 1)).body;
  assert.equal(server.config.id, standard.id);
  const pulled = await request(app).get('/v1/config').set(bearer(server.credential));
  assert.equal(pulled.body.version, 1);

  const update = await owner.client.put(`/api/agent-configs/${standard.id}`).send({
    settings: { sendIntervalSeconds: 60, collectors: { processes: false, shell: true } },
  });
  assert.equal(
    update.status,
    400,
    'unknown collectors are refused: remote settings only toggle built-ins',
  );
  assert.equal(
    (
      await owner.client
        .put(`/api/agent-configs/${standard.id}`)
        .send({ settings: { sendIntervalSeconds: 15, sampleIntervalSeconds: 30 } })
    ).status,
    400,
  );
  const ok = await owner.client
    .put(`/api/agent-configs/${standard.id}`)
    .send({ settings: { sendIntervalSeconds: 60, collectors: { processes: false } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.version, 2);
  assert.equal(ok.body.settings.collectors.processes, false);
  assert.equal(ok.body.settings.collectors.cpu, true);
  // The agent learns about the change from its next send.
  assert.equal((await ingest(server.credential)).body.configVersion, 2);
  assert.equal(
    (await request(app).get('/v1/config').set(bearer(server.credential))).body.settings
      .sendIntervalSeconds,
    60,
  );

  // A second profile can be chosen at install time; other organizations cannot touch these.
  const created = await owner.client
    .post('/api/agent-configs')
    .send({ name: 'Web servers', settings: { collectors: { network: false } } });
  assert.equal(created.status, 201);
  const web = (await enroll(key, 2, { setupId: created.body.id })).body;
  assert.equal(web.config.id, created.body.id);
  assert.equal(web.config.settings.collectors.network, false);
  const stranger = await register(app, 'Stranger');
  assert.equal(
    (await stranger.client.put(`/api/agent-configs/${standard.id}`).send({ settings: {} })).status,
    404,
  );
});

test('install steps reported before registration are attached to the server once it registers', async () => {
  const owner = await register(app, 'Steps');
  const key = await createKey(owner);
  const report = (step, extra = {}) =>
    request(app)
      .post('/v1/install-events')
      .set(bearer(key))
      .send({ fingerprint: fp(1), step, ...extra });
  assert.equal((await report('started')).status, 202);
  assert.equal((await report('downloaded')).status, 202);
  assert.equal((await report('failed', { message: 'checksum mismatch' })).status, 202);
  assert.equal((await report('exploded')).status, 400);
  assert.equal(
    (
      await request(app)
        .post('/v1/install-events')
        .send({ fingerprint: fp(1), step: 'started' })
    ).status,
    401,
  );
  assert.equal((await store.list('agentEvent', { orgId: owner.orgId, agentId: null })).length, 3);

  const server = (await enroll(key, 1)).body;
  const events = await store.list('agentEvent', { agentId: server.agentId });
  assert.deepEqual(events.map((e) => e.code).sort(), [
    'downloaded',
    'failed',
    'registered',
    'started',
  ]);
  assert.equal(events.find((e) => e.code === 'failed').message, 'checksum mismatch');
  await report('service_started');
  assert.ok(
    (await store.list('agentEvent', { agentId: server.agentId })).some(
      (e) => e.code === 'service_started',
    ),
  );
});

test('unknown /v1 paths answer with JSON, not the dashboard page', async () => {
  const response = await request(app).post('/v1/nothing').send({});
  assert.equal(response.status, 404);
  assert.match(response.headers['content-type'], /json/);
});

test('metrics live in a compressed hypertable with 5-minute and 1-hour rollups and retention policies', async () => {
  const jobs = await store.client.$queryRaw`
    SELECT j.proc_name AS job, coalesce(ca.view_name, j.hypertable_name) AS target
    FROM timescaledb_information.jobs j
    LEFT JOIN timescaledb_information.continuous_aggregates ca
      ON ca.materialization_hypertable_name = j.hypertable_name
    WHERE j.proc_name IN ('policy_retention', 'policy_compression', 'policy_refresh_continuous_aggregate')`;
  const has = (job, target) => jobs.some((j) => j.job === job && j.target === target);
  assert.ok(has('policy_retention', 'server_metrics'), 'raw samples are dropped after 8 days');
  assert.ok(has('policy_compression', 'server_metrics'));
  for (const view of ['server_metrics_5m', 'server_metrics_1h']) {
    assert.ok(has('policy_retention', view), `${view} has a retention policy`);
    assert.ok(has('policy_refresh_continuous_aggregate', view), `${view} refreshes itself`);
  }
  const [{ n }] = await store.client.$queryRaw`
    SELECT count(*)::int AS n FROM timescaledb_information.hypertables WHERE hypertable_name = 'server_metrics'`;
  assert.equal(n, 1);

  // The rollups include samples that have not been materialized yet.
  const owner = await register(app, 'Rollup');
  const server = (await enroll(await createKey(owner), 1)).body;
  const base = Math.floor(Date.now() / 300000) * 300000 - 300000; // the previous 5-minute bucket
  await ingest(
    server.credential,
    body(
      [10, 20, 60].map((cpu, i) => sample({ cpu, time: new Date(base + i * 30000).toISOString() })),
      { sentAt: new Date().toISOString() },
    ),
  );
  const [rollup] = await store.client.$queryRaw`
    SELECT cpu_avg, cpu_max, samples::int AS samples FROM server_metrics_5m WHERE agent_id = ${server.agentId}`;
  assert.deepEqual([rollup.cpu_avg, rollup.cpu_max, rollup.samples], [30, 60, 3]);
  const [hourly] = await store.client.$queryRaw`
    SELECT max(cpu_max) AS cpu_max FROM server_metrics_1h WHERE agent_id = ${server.agentId}`;
  assert.equal(hourly.cpu_max, 60);
});

test("each plan's shorter history limit is applied to raw samples", async () => {
  const free = await register(app, 'Short');
  const business = await register(app, 'Long');
  await upgrade(business, 'business');
  const day = 86400000;
  const rows = (org, agentId) =>
    [0.5, 5, 7.5].map((days) => ({
      time: new Date(Date.now() - days * day),
      agentId,
      orgId: org.orgId,
      cpuPercent: 1,
    }));
  await insertSamples(store, [...rows(free, 'free-agent'), ...rows(business, 'business-agent')]);
  await trimRawMetricsByPlan(store);
  const left = (agentId) => metricRows(agentId).then((r) => r.length);
  assert.equal(await left('free-agent'), 2, 'free keeps 7 days');
  assert.equal(
    await left('business-agent'),
    3,
    'longer plans keep everything the raw policy keeps',
  );
});
