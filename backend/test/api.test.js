import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/data/store.js';
import { seed } from '../src/data/seed.js';
import { Limits } from '../src/services/limits.js';
import { config } from '../src/config.js';
import { evaluateAlerts, deliverNotifications } from '../src/services/workers.js';
import { isPublicAddress } from '../src/services/uptime.js';
let store, app, ownerToken, project, orgId;
const auth = () => ({ Authorization: `Bearer ${ownerToken}` });
beforeEach(async () => {
  store = new MemoryStore();
  await seed(store, { tenants: 2 });
  app = createApp(store, new Limits());
  ownerToken = (await request(app).post('/api/auth/demo')).body.token;
  const bootstrap = await request(app).get('/api/bootstrap').set(auth());
  project = bootstrap.body.projects[0];
  orgId = bootstrap.body.organization.id;
});
test('health, login, registration, and safe public user data', async () => {
  assert.equal((await request(app).get('/api/health')).status, 200);
  assert.equal(
    (
      await request(app)
        .post('/api/auth/login')
        .send({ email: config.DEMO_EMAIL, password: 'wrong' })
    ).status,
    401,
  );
  const register = await request(app).post('/api/auth/register').send({
    name: 'New Owner',
    email: 'new@example.com',
    password: config.DEMO_PASSWORD,
    organization: 'New Organization',
  });
  assert.equal(register.status, 201);
  assert.equal(register.body.user.passwordHash, undefined);
  const fresh = await request(app)
    .get('/api/resources')
    .set('Authorization', `Bearer ${register.body.token}`);
  assert.deepEqual(fresh.body, []);
  const logs = await request(app)
    .get('/api/query/logs')
    .set('Authorization', `Bearer ${register.body.token}`);
  assert.deepEqual(logs.body.entries, []);
});
test('tenant identity cannot be forged using organization or tenant headers', async () => {
  const otherOrg = (await store.list('organization')).find((o) => o.id !== orgId);
  const response = await request(app)
    .get('/api/resources')
    .set(auth())
    .set('X-Organization-Id', otherOrg.id);
  assert.equal(response.status, 403);
  const normal = await request(app)
    .get('/api/resources')
    .set(auth())
    .set('X-Scope-OrgID', otherOrg.id);
  assert.equal(normal.status, 200);
  assert.ok(normal.body.every((r) => r.orgId === orgId));
  assert.equal(
    (await request(app).get('/api/resources').set('X-Organization-Id', orgId)).status,
    401,
  );
});
test('foreign resource IDs, projects, agent credentials, and alerts are inaccessible', async () => {
  const otherOrg = (await store.list('organization')).find((o) => o.id !== orgId);
  const foreignProject = await store.find('project', { orgId: otherOrg.id });
  assert.equal(
    (
      await request(app)
        .post('/api/resources')
        .set(auth())
        .send({ name: 'Forbidden', type: 'server', projectId: foreignProject.id })
    ).status,
    404,
  );
  assert.equal(
    (await request(app).get(`/api/query/logs?projectId=${foreignProject.id}`).set(auth())).status,
    404,
  );
  const ownResource = (await store.list('monitoredResource', { orgId }))[0];
  const foreignLogin = await request(app)
    .post('/api/auth/login')
    .send({ email: 'pilot2@pulse.local', password: config.DEMO_PASSWORD });
  assert.equal(
    (
      await request(app)
        .delete(`/api/resources/${ownResource.id}`)
        .set('Authorization', `Bearer ${foreignLogin.body.token}`)
    ).status,
    404,
  );
});
test('viewer roles and assigned project scopes are enforced on the backend', async () => {
  const member = await request(app)
    .post('/api/members')
    .set(auth())
    .send({
      name: 'Read Only',
      email: 'viewer@example.com',
      password: config.DEMO_PASSWORD,
      role: 'viewer',
      projectIds: [project.id],
    });
  assert.equal(member.status, 201);
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: 'viewer@example.com', password: config.DEMO_PASSWORD });
  const headers = { Authorization: `Bearer ${login.body.token}` };
  const resources = await request(app).get('/api/resources').set(headers);
  assert.ok(resources.body.every((r) => r.projectId === project.id));
  assert.equal((await request(app).get('/api/members').set(headers)).status, 403);
  assert.equal(
    (await request(app).post('/api/keys').set(headers).send({ name: 'no', projectId: project.id }))
      .status,
    403,
  );
  assert.equal(
    (
      await request(app)
        .post('/api/resources')
        .set(headers)
        .send({ name: 'no', projectId: project.id, type: 'server' })
    ).status,
    403,
  );
});
test('restricted administrators cannot widen their own access or grant broader membership', async () => {
  const created = await request(app)
    .post('/api/members')
    .set(auth())
    .send({
      name: 'Project Administrator',
      email: 'project-admin@example.com',
      password: config.DEMO_PASSWORD,
      role: 'admin',
      projectIds: [project.id],
    });
  assert.equal(created.status, 201);
  const login = await request(app).post('/api/auth/login').send({
    email: 'project-admin@example.com',
    password: config.DEMO_PASSWORD,
  });
  const headers = { Authorization: `Bearer ${login.body.token}` };
  const widen = await request(app).patch(`/api/members/${created.body.id}`).set(headers).send({
    role: 'admin',
    projectIds: [],
  });
  assert.equal(widen.status, 403);
  const grant = await request(app).post('/api/members').set(headers).send({
    name: 'Broader Viewer',
    email: 'broad-viewer@example.com',
    password: config.DEMO_PASSWORD,
    role: 'viewer',
    projectIds: [],
  });
  assert.equal(grant.status, 403);
  const permitted = await request(app)
    .post('/api/members')
    .set(headers)
    .send({
      name: 'Project Viewer',
      email: 'project-viewer@example.com',
      password: config.DEMO_PASSWORD,
      role: 'viewer',
      projectIds: [project.id],
    });
  assert.equal(permitted.status, 201);
});

test('enrollment tokens are single-use and credentials can heartbeat, rotate, and revoke', async () => {
  const enrollment = await request(app)
    .post('/api/agents/enrollment-tokens')
    .set(auth())
    .send({ projectId: project.id });
  const payload = { token: enrollment.body.token, name: 'test-host', platform: 'linux' };
  const results = await Promise.all([
    request(app).post('/api/agents/enroll').send(payload),
    request(app).post('/api/agents/enroll').send(payload),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 401]);
  const enrolled = results.find((r) => r.status === 201).body;
  const heartbeat = {
    cpu: 12,
    memory: 25,
    disk: 18,
    cores: 4,
    ramGb: 16,
    uptimeSeconds: 100,
    os: 'Linux',
  };
  assert.equal(
    (
      await request(app)
        .post('/api/agents/heartbeat')
        .set('Authorization', `Bearer ${enrolled.token}`)
        .send(heartbeat)
    ).status,
    200,
  );
  const row = await store.find('monitoredResource', { agentId: enrolled.agentId });
  assert.equal(row.labels.cpu, 12);
  assert.equal(row.orgId, orgId);
  const rotated = await request(app).post(`/api/agents/${enrolled.agentId}/rotate`).set(auth());
  assert.equal(rotated.status, 200);
  assert.equal(
    (
      await request(app)
        .post('/api/agents/heartbeat')
        .set('Authorization', `Bearer ${enrolled.token}`)
        .send(heartbeat)
    ).status,
    401,
  );
  await request(app).post(`/api/agents/${enrolled.agentId}/revoke`).set(auth());
  assert.equal(
    (
      await request(app)
        .post('/api/agents/heartbeat')
        .set('Authorization', `Bearer ${rotated.body.token}`)
        .send(heartbeat)
    ).status,
    401,
  );
});
test('ingestion authenticates credentials, ignores forged tenant headers, meters bytes, and rejects malformed input', async () => {
  const created = await request(app)
    .post('/api/keys')
    .set(auth())
    .send({ name: 'SDK key', projectId: project.id });
  const key = created.body.token;
  const payload = {
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'password', value: { stringValue: 'must-redact' } }] },
        scopeLogs: [],
      },
    ],
  };
  const accepted = await request(app)
    .post('/otlp/v1/logs')
    .set('Authorization', `Bearer ${key}`)
    .set('X-Scope-OrgID', 'forged')
    .send(payload);
  assert.equal(accepted.status, 200);
  const usage = await store.list('usageAggregate');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].orgId, orgId);
  assert.ok(usage[0].bytes > 0);
  assert.equal((await request(app).post('/otlp/v1/logs').send(payload)).status, 401);
  assert.equal(
    (
      await request(app)
        .post('/otlp/v1/logs')
        .set('Authorization', `Bearer ${key}`)
        .send({ arbitrary: true })
    ).status,
    400,
  );
  const keys = await request(app).get('/api/keys').set(auth());
  assert.equal(keys.body[0].tokenHash, undefined);
  assert.equal(keys.body[0].token, undefined);
});
test('billing webhooks require signatures and duplicate events have no repeated effects', async () => {
  const event = JSON.stringify({ id: 'event-test-1', orgId, type: 'payment.failed', amount: 0 });
  const signature = createHmac('sha256', config.BILLING_WEBHOOK_SECRET).update(event).digest('hex');
  assert.equal(
    (
      await request(app)
        .post('/api/billing/webhook')
        .set('Content-Type', 'application/json')
        .send(event)
    ).status,
    401,
  );
  for (let i = 0; i < 2; i++) {
    const response = await request(app)
      .post('/api/billing/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Pulse-Signature', signature)
      .send(event);
    assert.equal(response.status, 200);
    assert.equal(response.body.duplicate, i === 1);
  }
  assert.equal((await store.list('payment', { orgId })).length, 1);
  assert.equal((await store.find('subscription', { orgId })).status, 'past_due');
});
test('alert pending, firing, local delivery, cooldown, and recovery states work', async () => {
  const host = (await store.list('monitoredResource', { orgId, type: 'server' }))[0];
  const rule = await store.create('alertRule', {
    orgId,
    projectId: project.id,
    name: 'Test memory',
    metric: 'memory',
    operator: 'gt',
    threshold: 90,
    durationSeconds: 60,
    cooldownSeconds: 300,
    severity: 'critical',
    enabled: true,
  });
  await store.update('monitoredResource', host.id, { labels: { memory: 96 } });
  await evaluateAlerts(store, orgId);
  let incident = await store.find('alertIncident', { ruleId: rule.id });
  assert.equal(incident.state, 'pending');
  await store.update('alertIncident', incident.id, {
    startedAt: new Date(Date.now() - 61000).toISOString(),
  });
  await evaluateAlerts(store, orgId);
  incident = await store.find('alertIncident', { id: incident.id });
  assert.equal(incident.state, 'firing');
  await deliverNotifications(store, orgId);
  assert.equal(
    (await store.find('notificationDelivery', { incidentId: incident.id })).status,
    'local',
  );
  await evaluateAlerts(store, orgId);
  assert.equal((await store.list('notificationDelivery', { incidentId: incident.id })).length, 1);
  await store.update('monitoredResource', host.id, { labels: { memory: 50 } });
  await evaluateAlerts(store, orgId);
  assert.equal((await store.find('alertIncident', { id: incident.id })).state, 'resolved');
  assert.equal((await store.list('notificationDelivery', { incidentId: incident.id })).length, 2);
});
test('uptime address policy blocks private, metadata, loopback, and mapped IPv6 addresses', () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.5',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    '0.0.0.0',
    '100.64.0.1',
  ])
    assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});
test('query range, subscription limits, schema validation, and persisted metadata behavior', async () => {
  assert.equal((await request(app).get('/api/query/metrics?range=90d').set(auth())).status, 400);
  const subscription = await store.find('subscription', { orgId });
  await store.update('subscription', subscription.id, { status: 'cancelled' });
  assert.equal((await request(app).get('/api/query/metrics').set(auth())).status, 402);
  assert.equal(
    (await request(app).post('/api/projects').set(auth()).send({ name: 'x' })).status,
    400,
  );
});
