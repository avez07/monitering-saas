import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { allowLoopbackForTests } from '../src/services/uptime.js';
import { setup, closeStore, register, addMember } from './helpers.js';
import { createKey, registerAgent, enrollServer } from './agent-helpers.js';
import { fakeServer } from './b2-helpers.js';
import { config } from '../src/config.js';

let store, app, site;
beforeEach(async () => {
  ({ store, app } = await setup());
  allowLoopbackForTests(true);
  site = await fakeServer((req, res) => res.end('ok'));
});
afterEach(async () => {
  allowLoopbackForTests(false);
  config.BILLING_DEV_MODE = false;
  await site.close();
});
after(closeStore);

async function dockerProfile(owner) {
  const res = await owner.client.post('/api/agent-configs').send({
    name: 'Docker host',
    settings: { hostKind: 'docker-host', collectors: { docker: true } },
  });
  assert.equal(res.status, 201, res.text);
  return res.body.id;
}
async function dockerHost(owner, key, n) {
  const res = await registerAgent(app, key, n, { setupId: await dockerProfile(owner) });
  assert.equal(res.status, 201, res.text);
  return res.body.agentId;
}

test('docker hosts are hidden from the servers list unless asked for, and keep their kind', async () => {
  const owner = await register(app, 'Dock');
  const key = await createKey(owner);
  const plain = (await registerAgent(app, key, 1)).body.agentId;
  const docker = await dockerHost(owner, key, 2);
  const list = (await owner.client.get('/api/servers')).body;
  assert.deepEqual(list.map((s) => s.id), [plain]);
  assert.equal(list[0].kind, 'server');
  const all = (await owner.client.get('/api/servers?includeDockerHosts=true')).body;
  assert.equal(all.length, 2);
  assert.equal(all.find((s) => s.id === docker).kind, 'docker-host');
  const detail = await owner.client.get(`/api/servers/${docker}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.kind, 'docker-host');
});

test('docker hosts count toward the plan server limit', async () => {
  const owner = await register(app, 'Lim');
  const key = await createKey(owner);
  await dockerHost(owner, key, 1);
  assert.equal((await registerAgent(app, key, 2)).status, 201);
  assert.equal((await registerAgent(app, key, 3)).status, 402); // free plan: 2 servers
});

test('containers from every host are listed with the host kind', async () => {
  const owner = await register(app, 'Cont');
  const key = await createKey(owner);
  const docker = await dockerHost(owner, key, 1);
  const { agentId } = await enrollServer(app, owner, 2, key);
  const now = new Date();
  for (const [agent, name] of [[docker, 'web'], [agentId, 'db']])
    await store.client.containerItem.create({
      data: { orgId: owner.orgId, agentId: agent, name, state: 'running', reportedAt: now, lastSeen: now, firstSeen: now, stateChangedAt: now },
    });
  const items = (await owner.client.get('/api/containers')).body.items;
  assert.deepEqual(items.map((c) => [c.name, c.serverKind]), [['db', 'server'], ['web', 'docker-host']]);
});

test('docker collector can be enabled on an existing server and the version moves', async () => {
  const owner = await register(app, 'Enable');
  const { agentId } = await enrollServer(app, owner, 1);
  const detail = (await owner.client.get(`/api/servers/${agentId}`)).body;
  const settings = { ...detail.config.settings, collectors: { ...detail.config.settings.collectors, docker: true } };
  const res = await owner.client.patch(`/api/servers/${agentId}`).send({ config: settings });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.config.settings.collectors.docker, true);
  assert.equal(res.body.kind, 'server');
  const again = await owner.client.patch(`/api/servers/${agentId}`).send({ config: { ...settings, sendIntervalSeconds: 60 } });
  assert.equal(again.body.config.version, res.body.config.version + 1);
});

test('a config without hostKind keeps a docker host a docker host', async () => {
  const owner = await register(app, 'Keep');
  const key = await createKey(owner);
  const docker = await dockerHost(owner, key, 1);
  const res = await owner.client.patch(`/api/servers/${docker}`).send({ config: { sendIntervalSeconds: 60, collectors: { docker: true } } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.kind, 'docker-host');
});

test('POST /api/services creates a monitor for external types', async () => {
  const owner = await register(app, 'Mon');
  const res = await owner.client.post('/api/services').send({ type: 'website', name: 'Home', url: site.url('/') });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.status, 'pending');
  assert.equal(res.body.source, 'monitor');
  const sites = (await owner.client.get('/api/websites')).body.items;
  assert.equal(sites.length, 1);
  assert.equal(sites[0].id, res.body.id);
  const api = await owner.client.post('/api/services').send({ type: 'api', name: 'API', url: site.url('/h') });
  assert.equal((await owner.client.get('/api/websites')).body.items.find((s) => s.id === api.body.id).type, 'api');
  const tcp = await owner.client.post('/api/services').send({ type: 'tcp', name: 'Port', address: '127.0.0.1', port: site.port });
  assert.equal(tcp.status, 201, tcp.text);
  assert.equal((await owner.client.get('/api/websites')).body.items.find((s) => s.id === tcp.body.id).type, 'tcp');
  assert.equal((await owner.client.delete(`/api/services/${res.body.id}`)).status, 204);
  assert.equal((await owner.client.get('/api/websites')).body.items.length, 2);
});

test('POST /api/services writes agent types into the host config and bumps the version', async () => {
  const owner = await register(app, 'Cfg');
  const { agentId } = await enrollServer(app, owner, 1);
  const before = (await owner.client.get(`/api/servers/${agentId}`)).body.config;
  const res = await owner.client.post('/api/services').send({ type: 'redis', name: 'cache', host: agentId, port: 6380 });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.status, 'pending');
  assert.equal(res.body.source, 'agent');
  assert.equal(res.body.serverId, agentId);
  const s1 = (await owner.client.get(`/api/servers/${agentId}`)).body.config;
  assert.deepEqual(s1.settings.collectors.services, [{ kind: 'redis', name: 'cache', port: 6380 }]);
  assert.equal(s1.isDefault, false);
  assert.notEqual(s1.id, before.id); // the shared default profile is never edited
  const sys = await owner.client.post('/api/services').send({ type: 'systemd', name: 'SSH', unit: 'ssh.service', host: agentId });
  const nginx = await owner.client.post('/api/services').send({ type: 'nginx', name: 'web', host: agentId });
  const proc = await owner.client.post('/api/services').send({ type: 'process', name: 'Worker', processName: 'worker', host: agentId });
  const tcp = await owner.client.post('/api/services').send({ type: 'tcp', name: 'pg-port', host: agentId, port: 5432 });
  for (const r of [sys, nginx, proc, tcp]) assert.equal(r.status, 201, r.text);
  const s2 = (await owner.client.get(`/api/servers/${agentId}`)).body.config;
  assert.equal(s2.id, s1.id);
  assert.equal(s2.version, s1.version + 4);
  assert.deepEqual(
    s2.settings.collectors.services.map((s) => [s.kind, s.name]),
    [['redis', 'cache'], ['systemd', 'ssh.service'], ['nginx', 'web'], ['process', 'worker'], ['port', 'pg-port']],
  );
  assert.equal((await owner.client.post('/api/services').send({ type: 'redis', name: 'CACHE', host: agentId })).status, 409);
  // a pending entry can be removed by its id
  assert.equal((await owner.client.delete(`/api/services/${res.body.id}`)).status, 204);
  assert.equal((await owner.client.delete(`/api/services/${res.body.id}`)).status, 404);
  const s3 = (await owner.client.get(`/api/servers/${agentId}`)).body.config;
  assert.equal(s3.settings.collectors.services.length, 4);
  assert.equal(s3.version, s2.version + 1);
});

test('deleting a reported service removes it from the config', async () => {
  const owner = await register(app, 'Rep');
  const { agentId } = await enrollServer(app, owner, 1);
  await owner.client.post('/api/services').send({ type: 'mysql', name: 'db', host: agentId });
  const now = new Date();
  const row = await store.client.serviceItem.create({
    data: { orgId: owner.orgId, agentId, name: 'db', kind: 'mysql', state: 'running', reportedAt: now, lastSeen: now, firstSeen: now, stateChangedAt: now },
  });
  assert.equal((await owner.client.delete(`/api/services/${row.id}`)).status, 204);
  assert.deepEqual((await owner.client.get(`/api/servers/${agentId}`)).body.config.settings.collectors.services, []);
  assert.equal((await owner.client.get(`/api/services/${row.id}`)).status, 404);
});

test('POST /api/services validates, checks roles and scopes to the organization', async () => {
  const owner = await register(app, 'Val');
  const other = await register(app, 'Other');
  const { agentId } = await enrollServer(app, owner, 1);
  const post = (body, who = owner) => who.client.post('/api/services').send(body);
  assert.equal((await post({ type: 'bogus', name: 'x' })).status, 400);
  assert.equal((await post({ type: 'website', name: 'x' })).status, 400); // no url
  assert.equal((await post({ type: 'mysql', name: 'x' })).status, 400); // host required
  assert.equal((await post({ type: 'mysql', name: 'x', host: agentId, port: 70000 })).status, 400);
  assert.equal((await post({ type: 'mysql', name: 'x', host: agentId, extra: 1 })).status, 400);
  assert.equal((await post({ type: 'website', name: 'x', url: 'http://10.0.0.1/' })).status, 400); // not public
  assert.equal((await post({ type: 'mysql', name: 'x', host: agentId }, other)).status, 404);
  const viewer = await addMember(app, store, owner, { role: 'viewer' });
  assert.equal((await post({ type: 'mysql', name: 'x', host: agentId }, viewer)).status, 403);
  const admin = await addMember(app, store, owner, { role: 'admin' });
  assert.equal((await post({ type: 'mysql', name: 'x', host: agentId }, admin)).status, 201);
  const created = await post({ type: 'website', name: 'Site', url: site.url('/') });
  assert.equal((await other.client.delete(`/api/services/${created.body.id}`)).status, 404);
  assert.equal((await viewer.client.delete(`/api/services/${created.body.id}`)).status, 403);
  assert.equal((await owner.client.delete('/api/services/not-an-id')).status, 404);
});

test('billing defaults to INR with GST, USD only when chosen', async () => {
  const owner = await register(app, 'Inr');
  const info = (await owner.client.get('/api/billing')).body;
  assert.equal(info.defaultCurrency, 'INR');
  assert.equal(info.gst.rate, 0.18);
  // Checkout with no currency routes to Razorpay (not configured in tests).
  const noCurrency = await owner.client.post('/api/billing/checkout').send({ planId: 'starter' });
  assert.equal(noCurrency.status, 503);
  config.BILLING_DEV_MODE = true;
  const dev = await owner.client.post('/api/billing/change').send({ planId: 'starter', interval: 'monthly' });
  assert.equal(dev.status, 200, dev.text);
  {
    const inv = dev.body.invoice;
    assert.equal(inv.currency, 'INR');
    assert.equal(inv.taxRate, 0.18);
    assert.equal(inv.amount, inv.subtotal + inv.tax);
    assert.equal(inv.tax, Math.round(inv.subtotal * 0.18));
    assert.ok(inv.taxBreakdown.igst || inv.taxBreakdown.cgst);
    const usd = await owner.client.post('/api/billing/change').send({ planId: 'pro', interval: 'monthly', currency: 'USD' });
    assert.equal(usd.body.invoice.currency, 'USD');
    assert.equal(usd.body.invoice.tax, 0);
  }
});
