import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, closeStore, register, addMember } from './helpers.js';
import { enrollServer, createKey, registerAgent, ingest, payload, sample, setPlan } from './agent-helpers.js';

let store, app;
beforeEach(async () => {
  ({ store, app } = await setup());
});
after(closeStore);

const getServer = (owner, id) => owner.client.get(`/api/servers/${id}`);

test('the server list shows never_connected, online and offline with the latest numbers', async () => {
  const owner = await register(app, 'List');
  const a = await enrollServer(app, owner, 1);
  const b = await enrollServer(app, owner, 2, a.key);
  let list = (await owner.client.get('/api/servers')).body;
  assert.equal(list.length, 2);
  assert.ok(list.every((s) => s.status === 'never_connected' && s.lastSeen === null && s.cpu === null));

  await ingest(app, a.credential, payload([sample({ cpu: 33, memory: 44, disk: 55 })]));
  await ingest(app, b.credential);
  await store.update('agent', b.agentId, { lastSeen: new Date(Date.now() - 10 * 60000) });
  list = (await owner.client.get('/api/servers')).body;
  const one = list.find((s) => s.id === a.agentId);
  assert.equal(one.status, 'online');
  assert.deepEqual([one.cpu, one.memory, one.disk], [33, 44, 55]);
  assert.equal(one.hostname, 'host-1');
  assert.equal(one.agentVersion, '0.1.0');
  assert.equal(one.cores, 4);
  assert.ok(one.uptimeSeconds >= 0);
  assert.ok(one.resourceId);
  assert.equal(list.find((s) => s.id === b.agentId).status, 'offline');
});

test('server detail has the latest snapshot, disks, interfaces, processes and config', async () => {
  const owner = await register(app, 'Detail');
  const s = await enrollServer(app, owner);
  assert.equal((await getServer(owner, s.agentId)).body.latest, null);
  await ingest(app, s.credential);
  const d = (await getServer(owner, s.agentId)).body;
  assert.equal(d.latest.cpu, 12);
  assert.deepEqual(d.latest.load, [0.1, 0.2, 0.3]);
  assert.equal(d.disks[0].path, '/');
  assert.equal(d.interfaces[0].name, 'eth0');
  assert.equal(d.processes[0].name, 'node');
  assert.equal(d.config.isDefault, true);
  assert.equal(d.config.settings.sendIntervalSeconds, 30);
  assert.equal((await getServer(owner, 'nope')).status, 404);
});

test('rename and per-server config use a private copy of the shared profile and bump versions', async () => {
  const owner = await register(app, 'Edit');
  const s = await enrollServer(app, owner);
  const before = (await getServer(owner, s.agentId)).body.config;
  const renamed = await owner.client.patch(`/api/servers/${s.agentId}`).send({ name: 'Database 1' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, 'Database 1');
  assert.equal(renamed.body.hostname, 'host-1');

  const settings = { ...before.settings, sendIntervalSeconds: 60 };
  const edited = (await owner.client.patch(`/api/servers/${s.agentId}`).send({ config: settings })).body;
  assert.notEqual(edited.config.id, before.id, 'the shared default is not modified');
  assert.equal(edited.config.isDefault, false);
  assert.equal(edited.config.shared, false);
  assert.equal(edited.config.settings.sendIntervalSeconds, 60);
  assert.equal((await store.find('agentConfig', { id: before.id })).settings.sendIntervalSeconds, 30);
  const again = (
    await owner.client.patch(`/api/servers/${s.agentId}`).send({ config: { ...settings, sendIntervalSeconds: 120 } })
  ).body;
  assert.equal(again.config.id, edited.config.id);
  assert.equal(again.config.version, edited.config.version + 1);
  // The agent sees it on its next call.
  const pulled = await ingest(app, s.credential);
  assert.equal(pulled.body.config.id, edited.config.id);

  assert.equal(
    (await owner.client.patch(`/api/servers/${s.agentId}`).send({ config: { sendIntervalSeconds: 5 } })).status,
    400,
  );
  assert.equal((await owner.client.patch(`/api/servers/${s.agentId}`).send({ name: '' })).status, 400);
});

test('viewers can read servers but not change or delete them; other organizations cannot see them', async () => {
  const owner = await register(app, 'Roles');
  const other = await register(app, 'Other');
  const s = await enrollServer(app, owner);
  const viewer = await addMember(app, store, owner, { role: 'viewer' });
  assert.equal((await viewer.client.get('/api/servers')).body.length, 1);
  assert.equal((await viewer.client.get(`/api/servers/${s.agentId}/metrics?range=1h`)).status, 200);
  assert.equal((await viewer.client.patch(`/api/servers/${s.agentId}`).send({ name: 'x' })).status, 403);
  assert.equal((await viewer.client.delete(`/api/servers/${s.agentId}`)).status, 403);
  assert.equal((await other.client.get('/api/servers')).body.length, 0);
  assert.equal((await getServer(other, s.agentId)).status, 404);
  assert.equal((await other.client.patch(`/api/servers/${s.agentId}`).send({ name: 'x' })).status, 404);
  assert.equal((await request(app).get('/api/servers')).status, 401);
});

test('deleting a server removes it and cuts off its agent', async () => {
  const owner = await register(app, 'Delete');
  const s = await enrollServer(app, owner);
  await ingest(app, s.credential);
  assert.equal((await owner.client.delete(`/api/servers/${s.agentId}`)).status, 204);
  assert.equal((await owner.client.get('/api/servers')).body.length, 0);
  assert.equal((await getServer(owner, s.agentId)).status, 404);
  assert.equal((await ingest(app, s.credential)).status, 401);
});

const seed = (agentId, orgId, { days, stepSeconds }) =>
  store.client.$executeRawUnsafe(
    `INSERT INTO server_metrics (time, agent_id, org_id, cpu_percent, mem_percent, swap_percent, disk_percent,
       load1, load5, load15, net_rx_bps, net_tx_bps, disk_read_bps, disk_write_bps, uptime_seconds)
     SELECT t, $1, $2, 20 + 10 * sin(extract(epoch FROM t) / 3600), 50, 1, 60, 0.5, 0.4, 0.3,
       1000, 500, 10, 20, 1000
     FROM generate_series(now() - make_interval(days => $3::int), now() - interval '10 seconds',
       make_interval(secs => $4::float8)) AS t`,
    agentId,
    orgId,
    days,
    stepSeconds,
  );
// Materialize everything older than two hours; the newest part is served by the real-time aggregate.
// (Refreshing right up to "now" would move the watermark and hide samples other tests insert later.)
const refresh = async () => {
  for (const view of ['server_metrics_5m', 'server_metrics_1h'])
    await store.client.$executeRawUnsafe(
      `CALL refresh_continuous_aggregate('${view}', now() - interval '40 days', now() - interval '2 hours')`,
    );
};

test('chart ranges pick raw, 5-minute and 1-hour data and return aligned points', async () => {
  const owner = await register(app, 'Ranges');
  await setPlan(store, owner, 'business');
  const s = await enrollServer(app, owner);
  await seed(s.agentId, owner.orgId, { days: 9, stepSeconds: 60 });
  await refresh();
  const expected = {
    '1h': ['raw', null, 55, 61],
    '24h': ['5m', 300, 280, 290],
    '7d': ['1h', 3600, 166, 170],
    '30d': ['1h', 3600, 190, 220],
  };
  for (const [range, [source, bucket, min, max]] of Object.entries(expected)) {
    const r = await owner.client.get(`/api/servers/${s.agentId}/metrics?range=${range}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.source, source, range);
    assert.equal(r.body.bucketSeconds, bucket, range);
    assert.equal(r.body.clamped, false);
    const n = r.body.points.length;
    assert.ok(n >= min && n <= max, `${range}: ${n} points`);
    const p = r.body.points[Math.floor(n / 2)];
    for (const key of ['cpu', 'cpuMax', 'memory', 'swap', 'load1', 'disk', 'netRxBps', 'netTxBps', 'diskReadBps', 'diskWriteBps'])
      assert.equal(typeof p[key], 'number', `${range}.${key}`);
    assert.equal(p.memory, 50);
    assert.equal(p.disk, 60);
    const times = r.body.points.map((x) => new Date(x.t).getTime());
    assert.deepEqual(times, [...times].sort((x, y) => x - y));
    if (bucket) assert.ok(times.every((t) => t % (bucket * 1000) === 0), 'aligned to bucket boundaries');
  }
  const raw = (await owner.client.get(`/api/servers/${s.agentId}/metrics?range=1h`)).body.points[0];
  assert.equal(raw.load5, 0.4);
  assert.equal((await owner.client.get(`/api/servers/${s.agentId}/metrics`)).body.range, '24h');
  assert.equal((await owner.client.get(`/api/servers/${s.agentId}/metrics?range=2y`)).status, 400);
});

test('the Free plan clamps charts to its 7-day history', async () => {
  const owner = await register(app, 'Clamp');
  const s = await enrollServer(app, owner);
  await seed(s.agentId, owner.orgId, { days: 9, stepSeconds: 600 });
  await refresh();
  const r = (await owner.client.get(`/api/servers/${s.agentId}/metrics?range=30d`)).body;
  assert.equal(r.clamped, true);
  assert.ok(new Date(r.from) > new Date(Date.now() - 7.1 * 86400000));
  assert.ok(r.points.length <= 170);
});

test('30 days of data: the 30-day chart query takes under 300 ms', async () => {
  const owner = await register(app, 'Perf');
  await setPlan(store, owner, 'business');
  const s = await enrollServer(app, owner);
  await seed(s.agentId, owner.orgId, { days: 30, stepSeconds: 60 });
  await refresh();
  const url = `/api/servers/${s.agentId}/metrics?range=30d`;
  const first = await owner.client.get(url); // also warms the connection
  assert.equal(first.status, 200);
  assert.ok(first.body.points.length > 600, `${first.body.points.length} points`);
  const timings = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const r = await owner.client.get(url);
    timings.push(performance.now() - t0);
    assert.equal(r.status, 200);
  }
  const best = Math.min(...timings);
  const worst = Math.max(...timings);
  console.log(`30d chart request: best ${best.toFixed(0)} ms, worst ${worst.toFixed(0)} ms`);
  assert.ok(worst < 300, `30d chart took ${worst.toFixed(0)} ms`);
  void registerAgent;
  void createKey;
});
