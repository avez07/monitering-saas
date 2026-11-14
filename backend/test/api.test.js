import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { config, loadConfig } from '../src/config.js';
import { digest, verifyPassword } from '../src/lib/crypto.js';
import { evaluateAlerts, deliverNotifications, housekeeping } from '../src/services/workers.js';
import { isPublicAddress } from '../src/services/uptime.js';
import { setup, closeStore, browser, register, addMember, PASSWORD } from './helpers.js';

let store, app;
beforeEach(async () => {
  ({ store, app } = await setup());
});
after(async () => {
  await closeStore();
});

const server = (owner, name = 'srv-1') =>
  store.create('monitoredResource', {
    orgId: owner.orgId,
    projectId: owner.project.id,
    name,
    type: 'server',
    environment: 'production',
    status: 'healthy',
    labels: {},
  });

test('health, registration, login, and safe public user data', async () => {
  const health = await request(app).get('/api/health');
  assert.equal(health.status, 200);
  const owner = await register(app, 'New Owner');
  assert.equal(owner.user.passwordHash, undefined);
  assert.equal((await owner.client.get('/api/resources')).status, 200);
  assert.deepEqual((await owner.client.get('/api/resources')).body, []);
  const wrong = await browser(app)
    .post('/api/auth/login')
    .send({ email: owner.email, password: 'wrong-password' });
  assert.equal(wrong.status, 401);
  const duplicate = await browser(app)
    .post('/api/auth/register')
    .send({ name: 'Dup', email: owner.email, password: PASSWORD, organization: 'Dup Org' });
  assert.equal(duplicate.status, 409);
  // New organizations start on the free plan.
  const bootstrap = await owner.client.get('/api/bootstrap');
  assert.equal(bootstrap.body.plan.id, 'free');
  assert.equal(bootstrap.body.subscription.status, 'active');
});

test('session cookie is httpOnly and SameSite, only a hash is stored, and logout revokes it', async () => {
  const client = browser(app);
  const email = 'cookie@example.com';
  const registered = await client
    .post('/api/auth/register')
    .send({ name: 'Cookie Person', email, password: PASSWORD, organization: 'Cookie Org' });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.token, undefined, 'no token may be returned to page scripts');
  const cookie = registered.headers['set-cookie'].find((c) => c.startsWith('yuktiops_session='));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  const raw = decodeURIComponent(cookie.split(';')[0].split('=')[1]);
  const [row] = await store.list('session');
  assert.equal(row.tokenHash, digest(raw));
  assert.notEqual(row.tokenHash, raw);

  assert.equal((await client.get('/api/auth/me')).body.user.email, email);
  assert.equal((await client.post('/api/auth/logout')).status, 204);
  assert.equal((await client.get('/api/auth/me')).status, 401);
  // The old cookie value must be dead server-side, not just removed from the browser.
  const replay = await request(app)
    .get('/api/auth/me')
    .set('Cookie', `yuktiops_session=${encodeURIComponent(raw)}`);
  assert.equal(replay.status, 401);
});

test('logout-all revokes every session of the user, and expired or idle sessions are rejected', async () => {
  const owner = await register(app, 'Multi');
  const second = browser(app);
  await second.post('/api/auth/login').send({ email: owner.email, password: PASSWORD });
  assert.equal((await second.get('/api/auth/me')).status, 200);
  assert.equal((await owner.client.post('/api/auth/logout-all')).status, 204);
  assert.equal((await second.get('/api/auth/me')).status, 401);

  const third = browser(app);
  await third.post('/api/auth/login').send({ email: owner.email, password: PASSWORD });
  const [live] = await store.list('session', { revokedAt: null });
  await store.update('session', live.id, { lastUsedAt: new Date(Date.now() - 8 * 86400000) });
  assert.equal((await third.get('/api/auth/me')).status, 401, 'idle for 8 days');
  await store.update('session', live.id, {
    lastUsedAt: new Date(),
    expiresAt: new Date(Date.now() - 1000),
  });
  assert.equal((await third.get('/api/auth/me')).status, 401, 'past the absolute limit');
});

test('state-changing requests from another origin, or with no origin, are blocked (CSRF)', async () => {
  const owner = await register(app, 'Csrf');
  const body = { name: 'forged', projectId: owner.project.id, type: 'server' };
  // The browser would attach the session cookie to a cross-site form post, so reuse the signed-in client.
  const hostile = await owner.client
    .post('/api/resources')
    .set('Origin', 'https://evil.example')
    .send(body);
  assert.equal(hostile.status, 403);
  const none = await owner.client.post('/api/resources').unset('Origin').send(body);
  assert.equal(none.status, 403);
  assert.equal((await owner.client.get('/api/resources').unset('Origin')).status, 200);
  assert.equal((await owner.client.post('/api/resources').send(body)).status, 201);
  // Login CSRF: a foreign origin cannot sign a victim into the attacker's account either.
  const login = await request(app)
    .post('/api/auth/login')
    .set('Origin', 'https://evil.example')
    .send({ email: owner.email, password: PASSWORD });
  assert.equal(login.status, 403);
});

test('one account locks after 10 failed logins even when attempts come from many IPs', async () => {
  const owner = await register(app, 'Lockout');
  for (let i = 0; i < 10; i++) {
    const attempt = await browser(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', `203.0.113.${i + 1}`)
      .send({ email: owner.email, password: 'definitely-wrong' });
    assert.equal(attempt.status, 401, `attempt ${i + 1}`);
  }
  const locked = await browser(app)
    .post('/api/auth/login')
    .set('X-Forwarded-For', '203.0.113.99')
    .send({ email: owner.email, password: PASSWORD });
  assert.equal(locked.status, 429);
  // Other accounts are unaffected by someone else's lockout, so a shared proxy IP cannot lock everyone out.
  const other = await register(app, 'Bystander');
  const ok = await browser(app)
    .post('/api/auth/login')
    .set('X-Forwarded-For', '203.0.113.1')
    .send({ email: other.email, password: PASSWORD });
  assert.equal(ok.status, 200);
});

test('removed endpoints stay removed: demo login, member creation with a password, ingestion, queries', async () => {
  const owner = await register(app, 'Gone');
  assert.equal((await owner.client.post('/api/auth/demo')).status, 404);
  assert.equal(
    (await browser(app).post('/api/auth/demo')).status,
    401,
    'signed-out callers learn nothing',
  );
  const member = await owner.client.post('/api/members').send({
    name: 'Forced',
    email: 'forced@example.com',
    password: PASSWORD,
    role: 'viewer',
    projectIds: [],
  });
  assert.equal(member.status, 404);
  assert.equal(await store.find('user', { email: 'forced@example.com' }), null);
  assert.equal((await owner.client.get('/api/query/metrics')).status, 404);
  assert.equal((await owner.client.get('/api/keys')).status, 404);
  assert.equal((await request(app).post('/otlp/v1/metrics').send({})).status, 404);
});

test('security headers are sent and the framework banner is hidden', async () => {
  const response = await request(app).get('/api/health');
  assert.match(response.headers['content-security-policy'], /default-src 'self'/);
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-powered-by'], undefined);
});

test('production configuration refuses plain http and placeholder secrets', () => {
  const good = {
    NODE_ENV: 'production',
    APP_URL: 'https://app.yuktiops.com',
    API_PUBLIC_URL: 'https://api.yuktiops.com',
    DATABASE_URL: 'postgresql://app:Rk29x8vQzP1@db.internal:5432/yuktiops',
    BILLING_WEBHOOK_SECRET: 'f3a9c1d4e7b2486a90be5d17c8a2f6e0',
  };
  assert.doesNotThrow(() => loadConfig(good));
  assert.throws(() => loadConfig({ ...good, APP_URL: 'http://app.yuktiops.com' }), /https/);
  assert.throws(() => loadConfig({ ...good, API_PUBLIC_URL: 'http://api.yuktiops.com' }), /https/);
  assert.throws(
    () => loadConfig({ ...good, BILLING_WEBHOOK_SECRET: 'local-dummy-billing-webhook-secret' }),
    /BILLING_WEBHOOK_SECRET/,
  );
  assert.throws(() => loadConfig({ ...good, DATABASE_URL: undefined }), /DATABASE_URL/);
  // Development stays easy to run.
  assert.doesNotThrow(() =>
    loadConfig({ ...good, NODE_ENV: 'development', APP_URL: 'http://localhost:5173' }),
  );
});

test('a malformed stored password hash fails closed instead of crashing', () => {
  assert.equal(verifyPassword('anything', 'not-a-valid-hash'), false);
  assert.equal(verifyPassword('anything', ''), false);
  assert.equal(verifyPassword('anything', undefined), false);
});

test('tenant identity cannot be forged using organization headers or other tenants’ ids', async () => {
  const a = await register(app, 'Alpha');
  const b = await register(app, 'Beta');
  await server(a, 'alpha-server');
  const forged = await a.client.get('/api/resources').set('X-Organization-Id', b.orgId);
  assert.equal(forged.status, 403);
  const own = await a.client.get('/api/resources').set('X-Scope-OrgID', b.orgId);
  assert.equal(own.status, 200);
  assert.ok(own.body.every((r) => r.orgId === a.orgId));
  assert.equal((await request(app).get('/api/resources')).status, 401);
});

test('foreign projects, resources, and agents are inaccessible', async () => {
  const a = await register(app, 'Alpha');
  const b = await register(app, 'Beta');
  const resource = await server(a);
  const create = await b.client
    .post('/api/resources')
    .send({ name: 'Forbidden', type: 'server', projectId: a.project.id });
  assert.equal(create.status, 404);
  assert.equal((await b.client.delete(`/api/resources/${resource.id}`)).status, 404);
  const token = await a.client
    .post('/api/agents/enrollment-tokens')
    .send({ projectId: a.project.id });
  assert.equal(token.status, 201);
  const foreignToken = await b.client
    .post('/api/agents/enrollment-tokens')
    .send({ projectId: a.project.id });
  assert.equal(foreignToken.status, 404);
});

test('viewer roles and assigned project scopes are enforced on the backend', async () => {
  const owner = await register(app, 'Owner');
  const second = await store.create('project', {
    orgId: owner.orgId,
    name: 'Second',
    slug: 'second',
  });
  await store.create('monitoredResource', {
    orgId: owner.orgId,
    projectId: second.id,
    name: 'hidden-server',
    type: 'server',
    environment: 'production',
    status: 'healthy',
    labels: {},
  });
  await server(owner, 'visible-server');
  const viewer = await addMember(app, store, owner, {
    role: 'viewer',
    projectIds: [owner.project.id],
  });
  const resources = await viewer.client.get('/api/resources');
  assert.deepEqual(
    resources.body.map((r) => r.name),
    ['visible-server'],
  );
  assert.equal((await viewer.client.get('/api/members')).status, 403);
  assert.equal(
    (
      await viewer.client
        .post('/api/resources')
        .send({ name: 'no', projectId: owner.project.id, type: 'server' })
    ).status,
    403,
  );
  assert.equal(
    (
      await viewer.client
        .post('/api/agents/enrollment-tokens')
        .send({ projectId: owner.project.id })
    ).status,
    403,
  );
});

test('restricted administrators cannot widen their own access or grant broader membership', async () => {
  const owner = await register(app, 'Owner');
  const admin = await addMember(app, store, owner, {
    role: 'admin',
    projectIds: [owner.project.id],
  });
  const viewer = await addMember(app, store, owner, {
    role: 'viewer',
    projectIds: [owner.project.id],
  });
  const widen = await admin.client
    .patch(`/api/members/${admin.membership.id}`)
    .send({ role: 'admin', projectIds: [] });
  assert.equal(widen.status, 403);
  const promote = await admin.client
    .patch(`/api/members/${viewer.membership.id}`)
    .send({ role: 'admin', projectIds: [owner.project.id] });
  assert.equal(promote.status, 403);
  const broaden = await admin.client
    .patch(`/api/members/${viewer.membership.id}`)
    .send({ role: 'viewer', projectIds: [] });
  assert.equal(broaden.status, 403);
  const permitted = await admin.client
    .patch(`/api/members/${viewer.membership.id}`)
    .send({ role: 'editor', projectIds: [owner.project.id] });
  assert.equal(permitted.status, 200);
});

test('enrollment tokens are single-use and credentials can heartbeat, rotate, and revoke', async () => {
  const owner = await register(app, 'Owner');
  const enrollment = await owner.client
    .post('/api/agents/enrollment-tokens')
    .send({ projectId: owner.project.id });
  assert.match(enrollment.body.command, /--enroll enroll_[a-f0-9]{64} --api /);
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
  const beat = (token) =>
    request(app)
      .post('/api/agents/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send(heartbeat);
  assert.equal((await beat(enrolled.token)).status, 200);
  const row = await store.find('monitoredResource', { agentId: enrolled.agentId });
  assert.equal(row.labels.cpu, 12);
  assert.equal(row.orgId, owner.orgId);
  const rotated = await owner.client.post(`/api/agents/${enrolled.agentId}/rotate`);
  assert.equal(rotated.status, 200);
  assert.equal((await beat(enrolled.token)).status, 401);
  assert.equal((await beat(rotated.body.token)).status, 200);
  await owner.client.post(`/api/agents/${enrolled.agentId}/revoke`);
  assert.equal((await beat(rotated.body.token)).status, 401);
  // Only the hash of each credential is stored.
  for (const credential of await store.list('agentCredential'))
    assert.ok(![enrolled.token, rotated.body.token].includes(credential.tokenHash));
});

test('the free plan limits servers, website checks and check frequency', async () => {
  const owner = await register(app, 'Limits');
  const add = (name) =>
    owner.client.post('/api/resources').send({ name, type: 'server', projectId: owner.project.id });
  assert.equal((await add('one')).status, 201);
  assert.equal((await add('two')).status, 201);
  assert.equal((await add('three')).status, 402, 'free plan includes 2 servers');
  const tooFrequent = await owner.client
    .post('/api/uptime')
    .send({
      name: 'Fast',
      projectId: owner.project.id,
      target: 'https://1.1.1.1',
      intervalSeconds: 60,
    });
  assert.equal(tooFrequent.status, 402, 'free plan checks every 5 minutes at most');
  const fine = await owner.client
    .post('/api/uptime')
    .send({
      name: 'Ok',
      projectId: owner.project.id,
      target: 'https://1.1.1.1',
      intervalSeconds: 300,
    });
  assert.equal(fine.status, 201);
  // A paid plan lifts the free-plan server cap (extra servers are billed later)...
  const subscription = await store.find('subscription', { orgId: owner.orgId });
  await store.update('subscription', subscription.id, { planId: 'pro' });
  assert.equal((await add('three')).status, 201);
  // ...but an ended subscription cannot add anything.
  await store.update('subscription', subscription.id, { status: 'cancelled' });
  assert.equal((await add('four')).status, 402, 'a cancelled subscription cannot add resources');
});

test('billing webhooks require signatures and duplicate events have no repeated effects', async () => {
  const owner = await register(app, 'Billing');
  const event = JSON.stringify({
    id: 'event-test-1',
    orgId: owner.orgId,
    type: 'payment.failed',
    amount: 0,
  });
  const signature = createHmac('sha256', config.BILLING_WEBHOOK_SECRET).update(event).digest('hex');
  const post = () =>
    request(app).post('/api/billing/webhook').set('Content-Type', 'application/json');
  assert.equal((await post().send(event)).status, 401);
  assert.equal((await post().set('X-Yuktiops-Signature', 'ab'.repeat(32)).send(event)).status, 401);
  for (let i = 0; i < 2; i++) {
    const response = await post().set('X-Yuktiops-Signature', signature).send(event);
    assert.equal(response.status, 200);
    assert.equal(response.body.duplicate, i === 1);
  }
  assert.equal((await store.list('payment', { orgId: owner.orgId })).length, 1);
  assert.equal((await store.find('subscription', { orgId: owner.orgId })).status, 'past_due');
});

test('alert pending, firing, local delivery, cooldown, and recovery states work', async () => {
  const owner = await register(app, 'Alerts');
  const host = await server(owner, 'alert-host');
  const rule = await store.create('alertRule', {
    orgId: owner.orgId,
    projectId: owner.project.id,
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
  await evaluateAlerts(store, owner.orgId);
  let incident = await store.find('alertIncident', { ruleId: rule.id });
  assert.equal(incident.state, 'pending');
  await store.update('alertIncident', incident.id, {
    startedAt: new Date(Date.now() - 61000),
  });
  await evaluateAlerts(store, owner.orgId);
  incident = await store.find('alertIncident', { id: incident.id });
  assert.equal(incident.state, 'firing');
  await deliverNotifications(store, owner.orgId);
  assert.equal(
    (await store.find('notificationDelivery', { incidentId: incident.id })).status,
    'local',
  );
  await evaluateAlerts(store, owner.orgId);
  assert.equal((await store.list('notificationDelivery', { incidentId: incident.id })).length, 1);
  await store.update('monitoredResource', host.id, { labels: { memory: 50 } });
  await evaluateAlerts(store, owner.orgId);
  assert.equal((await store.find('alertIncident', { id: incident.id })).state, 'resolved');
  assert.equal((await store.list('notificationDelivery', { incidentId: incident.id })).length, 2);
});

test('uptime address policy blocks private, metadata, loopback, 6to4 and mapped IPv6 addresses', () => {
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
    '2002:7f00:1::1',
    '2002:a9fe:a9fe::1',
    '2001:db8::1',
  ])
    assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('housekeeping removes expired sessions and old check rows in bulk but keeps recent ones', async () => {
  const owner = await register(app, 'Cleanup');
  const monitor = await store.create('uptimeMonitor', {
    orgId: owner.orgId,
    projectId: owner.project.id,
    name: 'site',
    target: 'https://1.1.1.1',
    intervalSeconds: 300,
    failureThreshold: 3,
    status: 'healthy',
  });
  const check = (age) =>
    store.create('uptimeCheck', {
      orgId: owner.orgId,
      monitorId: monitor.id,
      ok: true,
      statusCode: 200,
      latencyMs: 12,
      createdAt: new Date(Date.now() - age * 86400000),
    });
  await check(30); // free plan keeps 7 days
  await check(1);
  const user = await store.find('user', { email: owner.email });
  await store.create('session', {
    userId: user.id,
    tokenHash: 'expired-session-hash',
    expiresAt: new Date(Date.now() - 1000),
  });
  await housekeeping(store);
  assert.equal((await store.list('uptimeCheck', { monitorId: monitor.id })).length, 1);
  assert.equal(await store.find('session', { tokenHash: 'expired-session-hash' }), null);
  assert.equal(
    (await owner.client.get('/api/auth/me')).status,
    200,
    'live session survives cleanup',
  );
});
