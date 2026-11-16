import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, closeStore, register, drainIngest } from './helpers.js';
import { enrollServer, ingestRaw, payload, sample } from './agent-helpers.js';
import { getRedis } from '../src/lib/redis.js';
import { setBackpressure, ingestQueue, ingestPressure } from '../src/queues/ingest-queues.js';
import { resetIngestRuntime, staleAgents, forgetLastSeen, flushLastSeen } from '../src/queues/ingest.js';

let store, app;
beforeEach(async () => {
  ({ store, app } = await setup());
});
after(closeStore);

const rows = (agentId) => store.client.serverMetric.findMany({ where: { agentId } });

test('ingest answers 202 with the config version and stores rows only after the worker drains', async () => {
  const owner = await register(app, 'Queue');
  const s = await enrollServer(app, owner);
  const config = await request(app).get('/v1/config').set({ Authorization: `Bearer ${s.credential}` });
  const response = await ingestRaw(app, s.credential, payload([sample({ cpu: 61 })]));
  assert.equal(response.status, 202);
  assert.equal(response.body.configVersion, config.body.version, 'same number /v1/config reports');
  assert.equal((await rows(s.agentId)).length, 0, 'nothing is written in the request path');
  assert.equal(await store.client.agent.count({ where: { id: s.agentId, status: 'healthy' } }), 0);
  assert.ok((await getRedis().zscore('lastseen', s.agentId)) > 0, 'last-seen is in the ZSET at once');

  await drainIngest();
  const stored = await rows(s.agentId);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].cpuPercent, 61);
  const agent = await store.find('agent', { id: s.agentId });
  assert.equal(agent.status, 'healthy');
  assert.ok(Date.now() - agent.lastSeen.getTime() < 60000);
  assert.ok((await store.list('agentEvent', { agentId: s.agentId })).some((e) => e.code === 'first_data'));
});

test('a batch of reports from many servers is written together, and re-processing is harmless', async () => {
  const owner = await register(app, 'Many');
  const a = await enrollServer(app, owner, 1);
  const b = await enrollServer(app, owner, 2, a.key);
  const body = payload([sample({ time: new Date(Date.now() - 20000).toISOString() }), sample()]);
  for (const s of [a, b]) assert.equal((await ingestRaw(app, s.credential, body)).status, 202);
  assert.equal((await ingestQueue().getWaitingCount()), 2);
  await drainIngest();
  assert.equal((await rows(a.agentId)).length, 2);
  assert.equal((await rows(b.agentId)).length, 2);
  // Same report again (an agent retry after a timeout): no duplicate rows, no duplicate first_data.
  assert.equal((await ingestRaw(app, a.credential, body)).status, 202);
  await drainIngest();
  assert.equal((await rows(a.agentId)).length, 2);
  assert.equal(await store.client.agentEvent.count({ where: { agentId: a.agentId, code: 'first_data' } }), 1);
});

test('backpressure: too many waiting jobs, or too old a one, answers 503 with Retry-After', async () => {
  const owner = await register(app, 'Busy');
  const s = await enrollServer(app, owner);
  setBackpressure({ maxWaiting: 1 });
  assert.equal((await ingestRaw(app, s.credential)).status, 202);
  assert.equal((await ingestRaw(app, s.credential)).status, 202); // 1 waiting is not over the limit (checked at most once a second)
  await new Promise((r) => setTimeout(r, 1100));
  const busy = await ingestRaw(app, s.credential);
  assert.equal(busy.status, 503);
  assert.ok(Number(busy.headers['retry-after']) >= 1);
  await drainIngest();
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal((await ingestRaw(app, s.credential)).status, 202, 'recovers once the queue drained');

  // Lag: the oldest waiting job is older than the allowed age (no worker is running, so it just waits).
  await resetIngestRuntime();
  assert.equal((await ingestRaw(app, s.credential)).status, 202);
  setBackpressure({ maxWaiting: 50000, maxLagMs: 150 });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok((await ingestPressure()).lagMs >= 150);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal((await ingestRaw(app, s.credential)).status, 503);
  await drainIngest();
});

test('last-seen is flushed in batches, and stale servers are found by scanning the ZSET', async () => {
  const owner = await register(app, 'Seen');
  const s = await enrollServer(app, owner);
  await ingestRaw(app, s.credential);
  assert.deepEqual(await staleAgents({ olderThanMs: 60000 }), []);
  assert.deepEqual(
    (await staleAgents({ olderThanMs: 60000, now: Date.now() + 120000 })).map((x) => x.agentId),
    [s.agentId],
  );
  await drainIngest();
  await getRedis().del('lastseen:flushed');
  assert.equal(await flushLastSeen(store), 1);
  assert.equal(await forgetLastSeen([s.agentId]), 1);
  assert.deepEqual(await staleAgents({ olderThanMs: 0, now: Date.now() + 1000 }), []);
});

test('unchanged container state is not rewritten, but its metrics are still stored', async () => {
  const owner = await register(app, 'Diff');
  const s = await enrollServer(app, owner);
  const c = { id: 'abc123', name: 'web', image: 'nginx', state: 'running', restartCount: 0, cpuPercent: 1, memoryBytes: 1e6 };
  const send = (cpu, secondsAgo) =>
    ingestRaw(app, s.credential, payload([sample()], {
      sentAt: new Date(Date.now() - secondsAgo * 1000).toISOString(),
      containers: [{ ...c, cpuPercent: cpu }],
    }));
  await send(1, 30);
  await drainIngest();
  const item = await store.client.containerItem.findFirst({ where: { agentId: s.agentId } });
  await send(2, 20);
  await send(3, 10);
  await drainIngest();
  const after = await store.client.containerItem.findFirst({ where: { agentId: s.agentId } });
  assert.equal(after.updatedAt.getTime(), item.updatedAt.getTime(), 'row not touched while unchanged');
  assert.equal(await store.client.containerMetric.count({ where: { agentId: s.agentId } }), 3);
});
