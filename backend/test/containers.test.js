import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { evaluateAlerts, deliverNotifications } from '../src/services/workers.js';
import { trimContainerMetricsByPlan } from '../src/services/containers.js';
import { setup, closeStore, register, addMember } from './helpers.js';
import { enrollServer, ingest, payload, sample } from './agent-helpers.js';
import { captureTransports, resetTransports } from './b2-helpers.js';

let store, app, sent;
beforeEach(async () => {
  ({ store, app } = await setup());
  sent = captureTransports();
});
afterEach(resetTransports);
after(closeStore);

const container = (over = {}) => ({
  id: 'abc123def456',
  name: 'web',
  image: 'nginx:1.27',
  state: 'running',
  status: 'Up 3 hours',
  restartCount: 0,
  cpuPercent: 1.5,
  memoryBytes: 5e7,
  memoryLimitBytes: 5e8,
  startedAt: '2026-11-15T07:00:00Z',
  ...over,
});
const svc = (over = {}) => ({ name: 'nginx', kind: 'systemd', state: 'running', detail: 'active (running)', ...over });

let tick = 0;
/** Send one snapshot; each call is 1 s newer than the previous one so retries and new sends differ. */
const send = (server, extra) =>
  ingest(
    app,
    server.credential,
    payload([sample()], { sentAt: new Date(Date.now() - 20000 + ++tick * 1000).toISOString(), ...extra }),
  );
async function fixture(name = 'Cont') {
  const owner = await register(app, name);
  const server = await enrollServer(app, owner, 1);
  return { owner, server };
}
const containersOf = async (owner, query = '') => (await owner.client.get(`/api/containers${query}`)).body;
const ruleFor = async (owner, key, extra = {}) => {
  const res = await owner.client.post('/api/alerts/rules/from-template').send({ templateKey: key, ...extra });
  assert.equal(res.status, 201, res.text);
  return res.body;
};
const evaluate = (owner, now = Date.now()) => evaluateAlerts(store, owner.orgId, { now });
const incidents = (owner) => store.list('alertIncident', { orgId: owner.orgId });

test('ingest validates and bounds the containers and services payload', async () => {
  const { server } = await fixture();
  const many = Array.from({ length: 101 }, (_, i) => container({ name: `c${i}`, id: `id${i}` }));
  assert.equal((await send(server, { containers: many })).status, 400);
  assert.equal((await send(server, { containers: [container({ state: 'weird' })] })).status, 400);
  assert.equal((await send(server, { containers: [container({ id: 'bad id!' })] })).status, 400);
  assert.equal((await send(server, { containers: [container({ cpuPercent: -1 })] })).status, 400);
  assert.equal((await send(server, { services: [svc({ kind: 'shell' })] })).status, 400);
  assert.equal((await send(server, { services: [svc({ state: 'on fire' })] })).status, 400);
  assert.equal(
    (await send(server, { services: Array.from({ length: 101 }, (_, i) => svc({ name: `s${i}` })) })).status,
    400,
  );
  assert.equal((await send(server, { containers: [container({ name: '/web' })], services: [svc()] })).status, 202);
  assert.equal((await store.client.containerItem.findFirst()).name, 'web'); // leading slash stripped
  // Payloads without the new fields still work and leave stored state alone.
  assert.equal((await send(server)).status, 202);
  assert.equal(await store.client.containerItem.count(), 1);
});

test('agent settings accept docker and a services list but never credentials', async () => {
  const { owner, server } = await fixture();
  const patch = (config) => owner.client.patch(`/api/servers/${server.agentId}`).send({ config });
  const ok = await patch({
    collectors: {
      docker: true,
      services: [
        { kind: 'systemd', name: 'nginx' },
        { kind: 'port', name: 'ssh', port: 22 },
        { kind: 'nginx', name: 'web', url: 'http://127.0.0.1/nginx_status' },
        { kind: 'redis', name: 'cache', host: '127.0.0.1', port: 6379 },
      ],
    },
  });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.config.settings.collectors.docker, true);
  assert.equal(ok.body.config.settings.collectors.services.length, 4);
  assert.equal(ok.body.config.settings.collectors.cpu, true);
  const base = { kind: 'redis', name: 'cache' };
  for (const bad of [
    [{ ...base, password: 'hunter2' }],
    [{ kind: 'systemd', name: 'a;rm -rf /' }],
    [{ kind: 'nginx', name: 'n', url: 'file:///etc/passwd' }],
    [{ kind: 'port', name: 'p' }],
    [{ kind: 'shell', name: 'x' }],
    [base, base],
    Array.from({ length: 51 }, (_, i) => ({ kind: 'process', name: `p${i}` })),
  ])
    assert.equal((await patch({ collectors: { services: bad } })).status, 400, JSON.stringify(bad).slice(0, 80));
});

test('containers: list, detail, metrics, transitions and events', async () => {
  const { owner, server } = await fixture();
  const db = (over = {}) => container({ id: 'zzz', name: 'db', image: 'postgres:16', state: 'exited', status: 'Exited (0)', ...over });
  await send(server, { containers: [container(), db()] });
  const list = await containersOf(owner);
  assert.equal(list.items.length, 2);
  assert.deepEqual([list.summary.total, list.summary.running, list.summary.stopped], [2, 1, 1]);
  const web = list.items.find((c) => c.name === 'web');
  assert.equal(web.state, 'running');
  assert.equal(web.serverId, server.agentId);
  assert.equal(web.memoryLimitBytes, 5e8);

  assert.equal((await containersOf(owner, '?state=stopped')).items.map((c) => c.name).join(), 'db');
  assert.equal((await containersOf(owner, `?serverId=${server.agentId}&q=we`)).items.length, 1);
  assert.equal((await containersOf(owner, '?serverId=nope')).items.length, 0);
  assert.equal((await owner.client.get('/api/containers?state=bogus')).status, 400);

  // Stop (OOM kill), then restart with a higher restart count.
  await send(server, { containers: [container({ state: 'exited', status: 'Exited (137)', oomKilled: true }), db()] });
  await send(server, { containers: [container({ restartCount: 2 }), db()] });
  const detail = (await owner.client.get(`/api/containers/${web.id}`)).body;
  assert.equal(detail.state, 'running');
  assert.equal(detail.restarts, 2);
  const types = detail.events.map((e) => e.type);
  for (const t of ['appeared', 'oom', 'started', 'restarted']) assert.ok(types.includes(t), `${t} in ${types}`);

  const m = await owner.client.get(`/api/containers/${web.id}/metrics?range=1h`);
  assert.equal(m.status, 200, m.text);
  assert.ok(m.body.points.length >= 3);
  assert.equal(m.body.points[0].cpu, 1.5);
  const bucketed = await owner.client.get(`/api/containers/${web.id}/metrics?range=24h`);
  assert.equal(bucketed.status, 200, bucketed.text);
  assert.ok(bucketed.body.points.length >= 1);
  assert.equal((await owner.client.get(`/api/containers/${web.id}/metrics?range=1y`)).status, 400);
  assert.equal((await owner.client.get('/api/containers/not-an-id')).status, 404);
});

test('a retried snapshot does not count twice', async () => {
  const { server } = await fixture();
  const body = payload([sample()], {
    sentAt: new Date(Date.now() - 5000).toISOString(),
    containers: [container({ state: 'exited' })],
  });
  await ingest(
    app,
    server.credential,
    payload([sample()], { sentAt: new Date(Date.now() - 9000).toISOString(), containers: [container()] }),
  );
  await ingest(app, server.credential, body);
  await ingest(app, server.credential, body);
  assert.equal((await store.client.containerItem.findFirst()).stoppedStreak, 1);
});

test('containers that vanish become removed after five minutes, not before', async () => {
  const { owner, server } = await fixture();
  await send(server, { containers: [container(), container({ id: 'q', name: 'old' })] });
  await send(server, { containers: [container()] });
  assert.equal((await containersOf(owner)).summary.running, 2); // just missed once: still shown
  await store.client.containerItem.updateMany({
    where: { name: 'old' },
    data: { lastSeen: new Date(Date.now() - 6 * 60000) },
  });
  await send(server, { containers: [container()] });
  const list = await containersOf(owner);
  assert.deepEqual(list.items.map((c) => c.name), ['web']);
  assert.equal(list.summary.removed, 1);
  assert.equal((await containersOf(owner, '?state=removed')).items[0].name, 'old');
  const old = await store.client.containerItem.findFirst({ where: { name: 'old' } });
  assert.ok((await owner.client.get(`/api/containers/${old.id}`)).body.events.some((e) => e.type === 'removed'));
  // No snapshot at all (Docker collector off) leaves everything as is.
  await store.client.containerItem.updateMany({
    where: { name: 'web' },
    data: { lastSeen: new Date(Date.now() - 6 * 60000) },
  });
  await send(server);
  assert.equal((await containersOf(owner)).items[0].state, 'running');
  // Removed rows are dropped after a week.
  await store.client.containerItem.update({
    where: { id: old.id },
    data: { lastSeen: new Date(Date.now() - 8 * 86400000) },
  });
  await send(server, { containers: [container()] });
  assert.equal(await store.client.containerItem.count({ where: { name: 'old' } }), 0);
});

test('Container stopped alerts after two ingests and recovers when running again', async () => {
  const { owner, server } = await fixture();
  const rule = await ruleFor(owner, 'container_stopped');
  assert.equal(rule.metric, 'container_stopped');
  const available = async () =>
    (await owner.client.get('/api/alerts/templates')).body.items.find((t) => t.key === 'container_stopped').available;
  assert.equal(await available(), false);
  await send(server, { containers: [container()] });
  await evaluate(owner);
  assert.equal((await incidents(owner)).length, 0);
  assert.equal(await available(), true);

  await send(server, { containers: [container({ state: 'exited' })] });
  await evaluate(owner);
  assert.equal((await incidents(owner)).length, 0, 'one stopped snapshot is not enough');
  await send(server, { containers: [container({ state: 'exited' })] });
  await evaluate(owner);
  const [incident] = await incidents(owner);
  assert.equal(incident.state, 'firing');
  assert.equal(incident.value, 1);
  assert.ok(incident.notified);
  await deliverNotifications(store);

  await send(server, { containers: [container()] });
  await evaluate(owner);
  await evaluate(owner, Date.now() + 61000);
  assert.equal((await incidents(owner))[0].state, 'resolved');
});

test('a container that was never running does not alert, and removal clears the alert', async () => {
  const { owner, server } = await fixture();
  await ruleFor(owner, 'container_stopped');
  await send(server, { containers: [container({ state: 'created' })] });
  await send(server, { containers: [container({ state: 'created' })] });
  await evaluate(owner);
  assert.equal((await incidents(owner)).length, 0);
  await send(server, { containers: [container()] });
  await send(server, { containers: [container({ state: 'exited' })] });
  await send(server, { containers: [container({ state: 'exited' })] });
  await evaluate(owner);
  assert.equal((await incidents(owner))[0].state, 'firing');
  await store.client.containerItem.updateMany({ data: { lastSeen: new Date(Date.now() - 6 * 60000) } });
  await send(server, { containers: [] });
  await evaluate(owner);
  await evaluate(owner, Date.now() + 61000);
  assert.equal((await incidents(owner))[0].state, 'resolved');
});

test('Service stopped: stopping nginx shows Stopped and alerts on the next evaluation', async () => {
  const { owner, server } = await fixture();
  await ruleFor(owner, 'service_stopped');
  const mysql = (over = {}) => svc({ name: 'mysql', kind: 'mysql', port: 3306, ...over });
  await send(server, { services: [svc(), mysql({ responseMs: 4 })] });
  await evaluate(owner);
  assert.equal((await incidents(owner)).length, 0);
  let list = (await owner.client.get('/api/services')).body;
  assert.deepEqual([list.summary.total, list.summary.running], [2, 2]);

  const stopped = { services: [svc({ state: 'stopped', detail: 'inactive' }), mysql()] };
  await send(server, stopped);
  await evaluate(owner);
  assert.equal((await incidents(owner)).length, 0);
  await send(server, stopped);
  await evaluate(owner);
  const [incident] = await incidents(owner);
  assert.equal(incident.state, 'firing');
  assert.match(incident.name, /Service stopped/);

  list = (await owner.client.get('/api/services?state=stopped')).body;
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].name, 'nginx');
  assert.equal((await owner.client.get('/api/services?kind=mysql')).body.items.length, 1);
  assert.equal((await owner.client.get(`/api/services?serverId=${server.agentId}`)).body.items.length, 2);
  const detail = (await owner.client.get(`/api/services/${list.items[0].id}`)).body;
  assert.ok(detail.events.some((e) => e.type === 'stopped'));

  // Running again recovers (an "unknown" service never alerts); a failed service alerts again.
  await send(server, { services: [svc(), mysql({ state: 'unknown' })] });
  await evaluate(owner);
  await evaluate(owner, Date.now() + 61000);
  assert.equal((await incidents(owner))[0].state, 'resolved');
  await send(server, { services: [svc({ state: 'failed' })] });
  await send(server, { services: [svc({ state: 'failed' })] });
  await evaluate(owner, Date.now() + 5000);
  assert.equal((await incidents(owner)).filter((i) => i.state === 'firing' && /Service stopped/.test(i.name)).length, 1);
});

test('services dropped from the config disappear after 15 minutes', async () => {
  const { owner, server } = await fixture();
  await send(server, { services: [svc(), svc({ name: 'redis', kind: 'redis' })] });
  await send(server, { services: [svc()] });
  assert.equal((await owner.client.get('/api/services')).body.items.length, 2);
  await store.client.serviceItem.updateMany({
    where: { name: 'redis' },
    data: { lastSeen: new Date(Date.now() - 16 * 60000) },
  });
  await send(server, { services: [svc()] });
  assert.deepEqual((await owner.client.get('/api/services')).body.items.map((s) => s.name), ['nginx']);
});

test('alerts are scoped to selected servers and to the organization', async () => {
  const { owner, server } = await fixture();
  const other = await enrollServer(app, owner, 2, server.key);
  await ruleFor(owner, 'container_stopped', { scope: { type: 'selected', ids: [other.agentId] } });
  for (let i = 0; i < 3; i++) await send(server, { containers: [container({ state: i ? 'exited' : 'running' })] });
  await evaluate(owner);
  assert.equal((await incidents(owner)).length, 0, 'stopped container is on a server outside the rule scope');
  for (let i = 0; i < 3; i++) await send(other, { containers: [container({ state: i ? 'exited' : 'running' })] });
  await evaluate(owner);
  assert.equal((await incidents(owner)).length, 1);

  // Another organization sees nothing and cannot open these rows.
  const stranger = await register(app, 'Stranger');
  assert.equal((await containersOf(stranger)).items.length, 0);
  const row = await store.client.containerItem.findFirst();
  assert.equal((await stranger.client.get(`/api/containers/${row.id}`)).status, 404);
  assert.equal((await stranger.client.get(`/api/containers/${row.id}/metrics`)).status, 404);
  await send(server, { services: [svc()] });
  const srow = await store.client.serviceItem.findFirst();
  assert.equal((await stranger.client.get(`/api/services/${srow.id}`)).status, 404);
  assert.equal((await stranger.client.get('/api/services')).body.items.length, 0);
});

test('viewers can read but there is nothing to write; sign-in is required', async () => {
  const { owner, server } = await fixture();
  await send(server, { containers: [container()], services: [svc()] });
  const viewer = await addMember(app, store, owner, { role: 'viewer' });
  assert.equal((await viewer.client.get('/api/containers')).body.items.length, 1);
  assert.equal((await viewer.client.get('/api/services')).body.items.length, 1);
  const row = await store.client.containerItem.findFirst();
  assert.notEqual((await viewer.client.delete(`/api/containers/${row.id}`)).status, 204);
  assert.notEqual((await viewer.client.post('/api/services').send({})).status, 201);
  assert.equal((await request(app).get('/api/containers')).status, 401);
  assert.equal((await request(app).get('/api/services')).status, 401);
});

test('container metrics are a hypertable with a retention policy; plans with short history are trimmed', async () => {
  const jobs = await store.client.$queryRaw`
    SELECT proc_name FROM timescaledb_information.jobs WHERE hypertable_name = 'container_metrics'`;
  const names = jobs.map((j) => j.proc_name);
  assert.ok(names.includes('policy_retention'), names.join());
  assert.ok(names.includes('policy_compression'), names.join());

  const { owner, server } = await fixture();
  await send(server, { containers: [container()] });
  const row = await store.client.containerItem.findFirst();
  const old = new Date(Date.now() - 7.5 * 86400000);
  await store.client.containerMetric.create({
    data: { time: old, containerId: row.id, agentId: server.agentId, orgId: owner.orgId, cpuPercent: 1 },
  });
  await trimContainerMetricsByPlan(store); // the free plan keeps 7 days
  assert.equal(await store.client.containerMetric.count({ where: { containerId: row.id, time: old } }), 0);
  assert.ok((await store.client.containerMetric.count({ where: { containerId: row.id } })) >= 1);
});
