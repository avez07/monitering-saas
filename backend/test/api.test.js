import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { config, loadConfig } from '../src/config.js';
import { digest, verifyPassword } from '../src/lib/crypto.js';
import { housekeeping } from '../src/services/workers.js';
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
  // The browser would attach the session cookie to a cross-site form post, so reuse the signed-in client.
  const hostile = await owner.client.post('/api/api-key').set('Origin', 'https://evil.example');
  assert.equal(hostile.status, 403);
  const none = await owner.client.post('/api/api-key').unset('Origin');
  assert.equal(none.status, 403);
  assert.equal(
    (await store.list('apiKey', { orgId: owner.orgId })).length,
    0,
    'nothing was created',
  );
  assert.equal((await owner.client.get('/api/resources').unset('Origin')).status, 200);
  assert.equal((await owner.client.post('/api/api-key')).status, 201);
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
  // Servers appear only when the agent registers with the account API key; the one-time token flow is gone.
  const manual = await owner.client
    .post('/api/resources')
    .send({ name: 'manual', type: 'server', projectId: owner.project.id });
  assert.equal(manual.status, 404);
  const retired = ['/api/agents/enrollment-tokens', '/api/agents/enroll', '/api/agents/heartbeat'];
  for (const path of retired) assert.equal((await owner.client.post(path).send({})).status, 404);
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
  assert.equal((await b.client.delete(`/api/resources/${resource.id}`)).status, 404);
  const agent = await store.create('agent', {
    orgId: a.orgId,
    projectId: a.project.id,
    name: 'alpha-agent',
    platform: 'linux',
    version: '1',
    status: 'healthy',
    lastSeen: new Date(),
  });
  assert.equal((await b.client.post(`/api/agents/${agent.id}/rotate`)).status, 404);
  assert.equal((await b.client.post(`/api/agents/${agent.id}/revoke`)).status, 404);
  assert.equal((await b.client.get('/api/agents')).body.length, 0);
});

test('viewers are read-only and see every project of the organization (no per-project scoping)', async () => {
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
  const viewer = await addMember(app, store, owner, { role: 'viewer' });
  const resources = await viewer.client.get('/api/resources');
  assert.deepEqual(resources.body.map((r) => r.name).sort(), ['hidden-server', 'visible-server']);
  assert.equal((await viewer.client.get('/api/members')).status, 403);
  assert.equal((await viewer.client.get('/api/api-key')).status, 403);
  assert.equal((await viewer.client.post('/api/api-key')).status, 403);
  assert.equal((await viewer.client.get('/api/agent-configs')).status, 403);
  assert.equal(
    (await viewer.client.delete(`/api/resources/${(await store.list('monitoredResource'))[0].id}`))
      .status,
    403,
  );
});

test('only the owner manages administrators; admins manage viewers', async () => {
  const owner = await register(app, 'Owner');
  const admin = await addMember(app, store, owner, { role: 'admin' });
  const viewer = await addMember(app, store, owner, { role: 'viewer' });
  const promote = await admin.client
    .patch(`/api/members/${viewer.membership.id}`)
    .send({ role: 'admin' });
  assert.equal(promote.status, 403);
  const demote = await admin.client
    .patch(`/api/members/${admin.membership.id}`)
    .send({ role: 'viewer' });
  assert.equal(demote.status, 403);
  assert.equal(
    (await owner.client.patch(`/api/members/${viewer.membership.id}`).send({ role: 'admin' })).status,
    200,
  );
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
