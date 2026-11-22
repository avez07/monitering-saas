import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { allowLoopbackForTests } from '../src/services/uptime.js';
import { getRedis } from '../src/lib/redis.js';
import { setup, closeStore, register, addMember } from './helpers.js';
import { enrollServer } from './agent-helpers.js';
import { fakeServer } from './b2-helpers.js';

let store, app, site;
beforeEach(async () => {
  ({ store, app } = await setup());
  allowLoopbackForTests(true);
  site = await fakeServer((req, res) => res.end('ok'));
});
afterEach(async () => {
  allowLoopbackForTests(false);
  await site.close();
});
after(closeStore);

const reported = (owner, agentId, over = {}) => {
  const now = new Date();
  return store.client.serviceItem.create({
    data: { orgId: owner.orgId, agentId, name: 'db', kind: 'mysql', state: 'running', reportedAt: now, lastSeen: now, firstSeen: now, stateChangedAt: now, ...over },
  });
};

test('PATCH /api/services/:id edits a monitor (name, url, interval) and keeps the POST shape', async () => {
  const owner = await register(app, 'EditMon');
  const created = await owner.client.post('/api/services').send({ type: 'website', name: 'Home', url: site.url('/') });
  assert.equal(created.status, 201, created.text);
  const res = await owner.client.patch(`/api/services/${created.body.id}`).send({ name: 'Landing', url: site.url('/new'), intervalSeconds: 600, failureThreshold: 3 });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(Object.keys(res.body).sort(), ['id', 'kind', 'monitorId', 'name', 'serverId', 'source', 'status', 'type']);
  assert.equal(res.body.id, created.body.id);
  assert.equal(res.body.name, 'Landing');
  assert.equal(res.body.source, 'monitor');
  assert.equal(res.body.type, 'website');
  const row = await store.client.uptimeMonitor.findUnique({ where: { id: created.body.id } });
  assert.equal(row.name, 'Landing');
  assert.match(row.target, /\/new$/);
  assert.equal(row.intervalSeconds, 600);
  assert.equal(row.failureThreshold, 3);
  const resource = await store.client.monitoredResource.findFirst({ where: { externalId: created.body.id } });
  assert.equal(resource.name, 'Landing');
  // plan minimum, strictness, empty body, wrong fields
  assert.equal((await owner.client.patch(`/api/services/${created.body.id}`).send({ intervalSeconds: 1 })).status, 402);
  assert.equal((await owner.client.patch(`/api/services/${created.body.id}`).send({})).status, 400);
  assert.equal((await owner.client.patch(`/api/services/${created.body.id}`).send({ type: 'api' })).status, 400);
  assert.equal((await owner.client.patch(`/api/services/${created.body.id}`).send({ port: 80 })).status, 400);
  assert.equal((await owner.client.patch(`/api/services/${created.body.id}`).send({ url: 'ftp://x.example.com/' })).status, 400);
  const tcp = await owner.client.post('/api/services').send({ type: 'tcp', name: 'Port', address: '127.0.0.1', port: site.port });
  const t = await owner.client.patch(`/api/services/${tcp.body.id}`).send({ port: site.port, address: '127.0.0.1', name: 'Port 2' });
  assert.equal(t.status, 200, t.text);
  assert.equal(t.body.type, 'tcp');
  assert.equal((await owner.client.patch('/api/services/00000000-0000-0000-0000-000000000000').send({ name: 'x' })).status, 404);
  assert.equal((await owner.client.patch('/api/services/nope').send({ name: 'x' })).status, 404);
});

test('PATCH /api/services/:id edits agent config entries by config id or reported id; the id follows the name', async () => {
  const owner = await register(app, 'EditCfg');
  const { agentId } = await enrollServer(app, owner, 1);
  const created = await owner.client.post('/api/services').send({ type: 'redis', name: 'cache', host: agentId, port: 6380 });
  const res = await owner.client.patch(`/api/services/${created.body.id}`).send({ name: 'cache2', port: 6381, address: 'db.internal' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.source, 'agent');
  assert.equal(res.body.name, 'cache2');
  assert.equal(res.body.serverId, agentId);
  assert.equal(res.body.monitorId, null);
  assert.notEqual(res.body.id, created.body.id);
  const services = async () => (await owner.client.get(`/api/servers/${agentId}`)).body.config.settings.collectors.services;
  assert.deepEqual(await services(), [{ kind: 'redis', name: 'cache2', port: 6381, host: 'db.internal' }]);
  // via the reported row's id
  const item = await reported(owner, agentId, { name: 'cache2', kind: 'redis' });
  const again = await owner.client.patch(`/api/services/${item.id}`).send({ port: 6390 });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.id, res.body.id);
  assert.equal((await services())[0].port, 6390);
  // unsupported fields, duplicates, stale ids
  assert.equal((await owner.client.patch(`/api/services/${res.body.id}`).send({ intervalSeconds: 60 })).status, 400);
  assert.equal((await owner.client.patch(`/api/services/${res.body.id}`).send({ url: 'http://127.0.0.1/x' })).status, 400);
  await owner.client.post('/api/services').send({ type: 'redis', name: 'other', host: agentId });
  assert.equal((await owner.client.patch(`/api/services/${res.body.id}`).send({ name: 'OTHER' })).status, 409);
  const sys = await owner.client.post('/api/services').send({ type: 'systemd', name: 'ssh', host: agentId, unit: 'ssh.service' });
  const renamed = await owner.client.patch(`/api/services/${sys.body.id}`).send({ unit: 'sshd.service' });
  assert.equal(renamed.body.name, 'sshd.service');
  assert.equal((await owner.client.patch(`/api/services/${sys.body.id}`).send({ name: 'x' })).status, 404, 'old id is gone after a rename');
});

test('PATCH /api/services/:id is admin-only and organization-scoped', async () => {
  const owner = await register(app, 'EditAuth');
  const created = await owner.client.post('/api/services').send({ type: 'website', name: 'Home', url: site.url('/') });
  const viewer = await addMember(app, store, owner, { role: 'viewer' });
  assert.equal((await viewer.client.patch(`/api/services/${created.body.id}`).send({ name: 'x' })).status, 403);
  const stranger = await register(app, 'Stranger');
  assert.equal((await stranger.client.patch(`/api/services/${created.body.id}`).send({ name: 'x' })).status, 404);
});

test('DELETE /api/services/:id works for reported rows of vanished hosts and is safe to repeat', async () => {
  const owner = await register(app, 'DelRep');
  const { agentId } = await enrollServer(app, owner, 1);
  const item = await reported(owner, agentId);
  // the host was removed (soft-deleted resource): the stale row must still be deletable
  await store.client.monitoredResource.updateMany({ where: { agentId }, data: { deletedAt: new Date() } });
  assert.equal((await owner.client.delete(`/api/services/${item.id}`)).status, 204);
  assert.equal(await store.client.serviceItem.count({ where: { id: item.id } }), 0);
  assert.equal((await owner.client.delete(`/api/services/${item.id}`)).status, 404);
});

test('DELETE /api/services/:id removes a monitor with its check history and soft-deletes its resource', async () => {
  const owner = await register(app, 'DelMon');
  const created = await owner.client.post('/api/services').send({ type: 'website', name: 'Home', url: site.url('/') });
  await store.client.uptimeCheck.create({ data: { orgId: owner.orgId, monitorId: created.body.id, ok: true, statusCode: 200, latencyMs: 12 } });
  assert.equal((await owner.client.delete(`/api/services/${created.body.id}`)).status, 204);
  assert.equal(await store.client.uptimeMonitor.count(), 0);
  assert.equal(await store.client.uptimeCheck.count(), 0);
  const resource = await store.client.monitoredResource.findFirst({ where: { externalId: created.body.id } });
  assert.ok(resource.deletedAt);
});

test('GET /api/servers survives odd labels, missing configs and stray query values', async () => {
  const owner = await register(app, 'Odd');
  const a = await enrollServer(app, owner, 1);
  const b = await enrollServer(app, owner, 2, a.key);
  await store.client.monitoredResource.updateMany({ where: { agentId: a.agentId }, data: { labels: ['not', 'an', 'object'] } });
  await store.client.monitoredResource.updateMany({ where: { agentId: b.agentId }, data: { labels: { cpu: '12', os: 42, memory: null, ramGb: 7.5 } } });
  await store.client.agent.update({ where: { id: b.agentId }, data: { configId: 'st_000000000000000000000000' } });
  for (const q of ['', '?includeDockerHosts=true', '?includeDockerHosts=1', '?includeDockerHosts=', '?includeDockerHosts=maybe', '?includeDockerHosts=true&includeDockerHosts=false', '?foo=bar']) {
    const res = await owner.client.get(`/api/servers${q}`);
    assert.equal(res.status, 200, `${q}: ${res.text}`);
    assert.equal(res.body.length, 2);
  }
  const odd = (await owner.client.get('/api/servers')).body.find((s) => s.id === b.agentId);
  assert.equal(odd.cpu, null, 'string labels are not numbers');
  assert.equal(odd.ramGb, 7.5);
  assert.equal(typeof odd.os, 'string');
});

test('creating a telemetry key and loading the connection still work when Redis last-seen reads fail', async () => {
  const owner = await register(app, 'OtelKey');
  const redis = getRedis();
  const hgetall = redis.hgetall;
  redis.hgetall = async () => {
    throw new Error('redis down');
  };
  try {
    const created = await owner.client.post('/api/telemetry-keys').send({ name: 'production' });
    assert.equal(created.status, 201, created.text);
    assert.deepEqual(Object.keys(created.body).sort(), ['createdAt', 'id', 'key', 'lastSeenAt', 'lastUsedAt', 'name', 'prefix']);
    assert.match(created.body.key, /^yk_otel_/);
    assert.equal(created.body.lastSeenAt, null);
    const conn = await owner.client.get('/api/apps/connection');
    assert.equal(conn.status, 200, conn.text);
    assert.equal(conn.body.keys.length, 1);
    assert.equal((await owner.client.get('/api/telemetry-keys')).status, 200);
  } finally {
    redis.hgetall = hgetall;
  }
  assert.equal((await owner.client.post('/api/telemetry-keys').send({ name: '' })).status, 400);
});
