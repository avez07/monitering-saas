import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, closeStore, register } from './helpers.js';
import { enrollServer, bearer, setPlan } from './agent-helpers.js';
import { onPlanChanged } from '../src/services/agent-config.js';
import { runDunning, billingProvider, planChanged } from '../src/services/billing.js';

let store, app;
beforeEach(async () => ({ store, app } = await setup()));
after(closeStore);

const agentConfig = async (credential) => {
  const res = await request(app).get('/v1/config').set(bearer(credential));
  assert.equal(res.status, 200, res.text);
  return res.body;
};
const defaultProfile = (orgId) => store.find('agentConfig', { orgId, isDefault: true });

test('upgrading bumps every profile version and turns collectors.prometheus on; downgrading turns it off', async () => {
  const owner = await register(app, 'Plan');
  const server = await enrollServer(app, owner, 1);
  const before = await agentConfig(server.credential);
  assert.equal(before.settings.collectors.prometheus, false);
  assert.equal(before.settings.prometheus.path, '/v1/prom/write');
  const v0 = (await defaultProfile(owner.orgId)).version;

  // Upgrade (the dev billing provider changes the subscription, then billing calls the hook).
  const pro = await store.find('subscriptionPlan', { id: 'pro' });
  await billingProvider.changeSubscription(store, owner.orgId, pro, 'monthly');
  await planChanged(store, owner.orgId);
  const up = await agentConfig(server.credential);
  assert.equal(up.version, v0 + 1);
  assert.equal(up.settings.collectors.prometheus, true);
  assert.deepEqual(up.plan, { name: 'Pro' });
  assert.equal((await defaultProfile(owner.orgId)).settings.collectors.prometheus, true);

  // Same plan again: nothing to change, no version bump.
  assert.deepEqual(await onPlanChanged(store, owner.orgId), { enabled: true, changed: 0 });
  assert.equal((await agentConfig(server.credential)).version, v0 + 1);

  // Dunning moves an unpaid subscription to Free and the collector goes off with a new version.
  const sub = await store.find('subscription', { orgId: owner.orgId });
  await store.update('subscription', sub.id, { status: 'past_due', pastDueSince: new Date(Date.now() - 8 * 86400000) });
  assert.equal(await runDunning(store), 1);
  const down = await agentConfig(server.credential);
  assert.equal(down.version, v0 + 2);
  assert.equal(down.settings.collectors.prometheus, false);
});

test('every profile of the org follows the plan, including a server-specific one', async () => {
  const owner = await register(app, 'Profiles');
  const server = await enrollServer(app, owner, 1);
  // Give the server its own profile through the servers API.
  const res = await owner.client.patch(`/api/servers/${server.agentId}`).send({ config: { sendIntervalSeconds: 60 } });
  assert.ok([200, 204].includes(res.status), res.text);
  const own = await store.find('agent', { id: server.agentId });
  assert.ok(own.configId);
  const ownBefore = await store.find('agentConfig', { id: own.configId });

  await setPlan(store, owner, 'business');
  const result = await onPlanChanged(store, owner.orgId);
  assert.equal(result.enabled, true);
  assert.equal(result.changed, 2);
  const ownAfter = await store.find('agentConfig', { id: own.configId });
  assert.equal(ownAfter.version, ownBefore.version + 1);
  assert.equal(ownAfter.settings.collectors.prometheus, true);
  assert.equal(ownAfter.settings.sendIntervalSeconds, 60);
  assert.equal((await agentConfig(server.credential)).settings.collectors.prometheus, true);
});

test('users cannot switch collectors.prometheus themselves', async () => {
  const owner = await register(app, 'Sneaky');
  const server = await enrollServer(app, owner, 1);
  const [profile] = (await owner.client.get('/api/agent-configs')).body;
  const put = await owner.client
    .put(`/api/agent-configs/${profile.id}`)
    .send({ settings: { collectors: { prometheus: true }, prometheus: { path: '/somewhere/else' } } });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.body.settings.collectors.prometheus, false);
  assert.equal(put.body.settings.prometheus.path, '/v1/prom/write');
  const created = await owner.client.post('/api/agent-configs').send({ name: 'Mine', settings: { collectors: { prometheus: true } } });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.body.settings.collectors.prometheus, false);
  // Even a value written straight into the database is not what the agent is served.
  const row = await defaultProfile(owner.orgId);
  await store.update('agentConfig', row.id, { settings: { ...row.settings, collectors: { ...row.settings.collectors, prometheus: true } } });
  assert.equal((await agentConfig(server.credential)).settings.collectors.prometheus, false);

  // On a premium plan a save keeps it on even when the client sends false.
  await setPlan(store, owner, 'pro');
  const keep = await owner.client.put(`/api/agent-configs/${profile.id}`).send({ settings: { collectors: { prometheus: false } } });
  assert.equal(keep.body.settings.collectors.prometheus, true);
});

test('settings accept mssql services and credentialsRef, and reject a bad ref', async () => {
  const owner = await register(app, 'Mssql');
  const [profile] = (await owner.client.get('/api/agent-configs')).body;
  const ok = await owner.client.put(`/api/agent-configs/${profile.id}`).send({
    settings: {
      collectors: {
        services: [
          { kind: 'mssql', name: 'sql', port: 1433, credentialsRef: 'mssql-main' },
          { kind: 'redis', name: 'cache', credentialsRef: 'redis-main' },
        ],
        containerLogs: { enabled: true, include: ['web'], exclude: [] },
      },
    },
  });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.settings.collectors.services[0].credentialsRef, 'mssql-main');
  assert.equal(ok.body.settings.prometheus.scrapeIntervalSeconds, 15);
  const bad = await owner.client.put(`/api/agent-configs/${profile.id}`).send({
    settings: { collectors: { services: [{ kind: 'redis', name: 'cache', credentialsRef: 'Bad Ref!' }] } },
  });
  assert.equal(bad.status, 400);
});
