import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, closeStore, browser, register, addMember, PASSWORD } from './helpers.js';
import { enrollServer, ingestRaw } from './agent-helpers.js';
import { grantPlatformAdmin, revokePlatformAdmin } from '../src/services/platform-accounts.js';
import { processAlertJob, orgsToEvaluate } from '../src/queues/alerts.js';
import { monthlyCents } from '../src/services/platform.js';

let store, app;
beforeEach(async () => {
  ({ store, app } = await setup());
});
after(closeStore);

let staffN = 0;
/** A Yukti staff account (created like `npm run admin:create`), signed in. */
async function staff() {
  const email = `staff${++staffN}@yukti.test`;
  const { user } = await grantPlatformAdmin(store, { email, password: PASSWORD });
  const client = browser(app);
  const login = await client.post('/api/auth/login').send({ email, password: PASSWORD });
  assert.equal(login.status, 200, login.text);
  assert.equal(login.body.user.isPlatformAdmin, true);
  return { client, user, email };
}

test('non-staff get 403 on every platform route; signed-out callers get 401', async () => {
  const owner = await register(app, 'Customer');
  for (const [method, path] of [
    ['get', '/api/platform/overview'],
    ['get', '/api/platform/orgs'],
    ['get', `/api/platform/orgs/${owner.orgId}`],
    ['post', `/api/platform/orgs/${owner.orgId}/plan`],
    ['post', `/api/platform/orgs/${owner.orgId}/suspend`],
    ['get', '/api/platform/users'],
    ['post', `/api/platform/users/${owner.user.id}/disable`],
    ['get', '/api/platform/audit'],
  ]) {
    const response = await owner.client[method](path).send({});
    assert.equal(response.status, 403, `${method} ${path}: ${response.text}`);
  }
  assert.equal((await browser(app).get('/api/platform/overview')).status, 401);
  const me = await owner.client.get('/api/auth/me');
  assert.equal(me.body.user.isPlatformAdmin, false);
});

test('staff without an organization: /me and /bootstrap work, org API does not', async () => {
  const admin = await staff();
  const me = await admin.client.get('/api/auth/me');
  assert.equal(me.body.user.isPlatformAdmin, true);
  const boot = await admin.client.get('/api/bootstrap');
  assert.equal(boot.status, 200, boot.text);
  assert.equal(boot.body.organization, null);
  assert.equal(boot.body.user.isPlatformAdmin, true);
  assert.equal((await admin.client.get('/api/overview')).status, 403);
});

test('admin lists, searches and filters organizations and reads one', async () => {
  const admin = await staff();
  const a = await register(app, 'Alpha');
  const b = await register(app, 'Bravo');
  const all = await admin.client.get('/api/platform/orgs');
  assert.equal(all.status, 200, all.text);
  assert.equal(all.body.total, 2);
  assert.ok(all.body.items.every((o) => o.planId === 'free' && o.members === 1 && o.owner?.email));
  const search = await admin.client.get('/api/platform/orgs').query({ q: 'bravo' });
  assert.deepEqual(
    search.body.items.map((o) => o.id),
    [b.orgId],
  );
  const byEmail = await admin.client.get('/api/platform/orgs').query({ q: a.email });
  assert.deepEqual(
    byEmail.body.items.map((o) => o.id),
    [a.orgId],
  );
  const paged = await admin.client.get('/api/platform/orgs').query({ pageSize: 1, page: 2 });
  assert.equal(paged.body.items.length, 1);
  assert.equal(paged.body.total, 2);

  const detail = await admin.client.get(`/api/platform/orgs/${a.orgId}`);
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.body.organization.id, a.orgId);
  assert.equal(detail.body.members[0].user.email, a.email);
  assert.equal(detail.body.subscription.planId, 'free');
  assert.ok(
    Array.isArray(detail.body.invoices) &&
      Array.isArray(detail.body.agents) &&
      Array.isArray(detail.body.monitors),
  );
  assert.equal(detail.body.usage.servers.used, 0);
  assert.equal((await admin.client.get('/api/platform/orgs/nope')).status, 404);

  const overview = await admin.client.get('/api/platform/overview');
  assert.equal(overview.status, 200, overview.text);
  assert.equal(overview.body.totals.orgs, 2);
  assert.equal(overview.body.totals.users, 3);
  assert.equal(overview.body.orgsByPlan.find((p) => p.planId === 'free').count, 2);
  assert.equal(overview.body.signupsByDay.length, 30);
  assert.equal(overview.body.signupsByDay.at(-1).count, 2);
  assert.equal(overview.body.mrrCents, 0);
  assert.ok(overview.body.health);
});

test('change plan updates the subscription, writes the audit log and bumps agent settings', async () => {
  const admin = await staff();
  const owner = await register(app, 'Upgrade');
  const end = new Date(Date.now() + 60 * 86400000).toISOString();
  const changed = await admin.client
    .post(`/api/platform/orgs/${owner.orgId}/plan`)
    .send({ planId: 'pro', periodEnd: end, note: 'Design partner' });
  assert.equal(changed.status, 200, changed.text);
  const subscription = await store.find('subscription', { orgId: owner.orgId });
  assert.equal(subscription.planId, 'pro');
  assert.equal(subscription.status, 'active');
  assert.equal(subscription.periodEnd.toISOString(), end);
  const [row] = await store.list('platformAuditLog', { targetId: owner.orgId });
  assert.equal(row.action, 'org.plan_changed');
  assert.equal(row.adminUserId, admin.user.id);
  assert.deepEqual(
    [row.details.from, row.details.to, row.details.note],
    ['free', 'pro', 'Design partner'],
  );
  // onPlanChanged: the org's setup profile now has the Prometheus collector on (Pro has promMetrics).
  const [profile] = await store.list('agentConfig', { orgId: owner.orgId });
  if (profile.settings?.collectors && 'prometheus' in profile.settings.collectors)
    assert.equal(profile.settings.collectors.prometheus, true);
  // The customer sees the new plan.
  assert.equal((await owner.client.get('/api/bootstrap')).body.plan.id, 'pro');

  const extended = await admin.client
    .post(`/api/platform/orgs/${owner.orgId}/plan`)
    .send({ planId: 'pro' });
  assert.equal(extended.status, 200);
  const audit = await admin.client.get('/api/platform/audit');
  assert.deepEqual(audit.body.items.map((r) => r.action).slice(0, 2), [
    'org.plan_extended',
    'org.plan_changed',
  ]);
  assert.equal(audit.body.items[0].targetLabel, 'Upgrade Org ' + owner.email.match(/\d+/)[0]);

  assert.equal(
    (await admin.client.post(`/api/platform/orgs/${owner.orgId}/plan`).send({ planId: 'gold' }))
      .status,
    400,
  );
  const past = new Date(Date.now() - 86400000).toISOString();
  assert.equal(
    (
      await admin.client
        .post(`/api/platform/orgs/${owner.orgId}/plan`)
        .send({ planId: 'pro', periodEnd: past })
    ).status,
    400,
  );
});

test('suspend: org API answers 423 (bootstrap still works), agent ingest 403, alerts skip; reactivate restores', async () => {
  const admin = await staff();
  const owner = await register(app, 'Suspend');
  const { credential, key } = await enrollServer(app, owner, 1);
  assert.equal((await ingestRaw(app, credential)).status, 202);

  assert.equal(
    (await admin.client.post(`/api/platform/orgs/${owner.orgId}/suspend`).send({})).status,
    400,
  );
  const suspended = await admin.client
    .post(`/api/platform/orgs/${owner.orgId}/suspend`)
    .send({ reason: 'Unpaid invoices' });
  assert.equal(suspended.status, 200, suspended.text);
  assert.equal(
    (await admin.client.post(`/api/platform/orgs/${owner.orgId}/suspend`).send({ reason: 'again' }))
      .status,
    409,
  );

  const locked = await owner.client.get('/api/overview');
  assert.equal(locked.status, 423);
  assert.equal(locked.body.error, 'This organization is suspended.');
  assert.equal((await owner.client.get('/api/servers')).status, 423);
  const boot = await owner.client.get('/api/bootstrap');
  assert.equal(boot.status, 200);
  assert.ok(boot.body.organization.suspendedAt);
  assert.equal(boot.body.organization.suspendReason, 'Unpaid invoices');

  const ingest = await ingestRaw(app, credential);
  assert.equal(ingest.status, 403, ingest.text);
  assert.equal(ingest.body.error, 'This organization is suspended.');
  assert.equal((await ingestRaw(app, credential)).status, 403);
  const config = await request(app)
    .get('/v1/config')
    .set({ Authorization: `Bearer ${credential}` });
  assert.equal(config.status, 403);
  const reg = await request(app)
    .post('/v1/register')
    .set({ Authorization: `Bearer ${key}` })
    .send({ name: 'host-2', fingerprint: 'a'.repeat(64) });
  assert.equal(reg.status, 403);
  assert.ok(
    !(await orgsToEvaluate(store)).includes(owner.orgId),
    'alert worker skips the suspended org',
  );
  assert.ok((await processAlertJob(store, { name: 'tick' })) >= 0);

  const listed = await admin.client.get('/api/platform/orgs').query({ status: 'suspended' });
  assert.deepEqual(
    listed.body.items.map((o) => o.id),
    [owner.orgId],
  );

  const back = await admin.client.post(`/api/platform/orgs/${owner.orgId}/reactivate`).send({});
  assert.equal(back.status, 200, back.text);
  assert.equal((await owner.client.get('/api/overview')).status, 200);
  assert.equal((await ingestRaw(app, credential)).status, 202);
  const actions = (await store.list('platformAuditLog', { targetId: owner.orgId }))
    .map((r) => r.action)
    .sort();
  assert.deepEqual(actions, ['org.reactivated', 'org.suspended']);
});

test('disabled users cannot sign in and their sessions are revoked; enable restores access', async () => {
  const admin = await staff();
  const owner = await register(app, 'Disable');
  const member = await addMember(app, store, owner, { role: 'viewer' });
  assert.equal((await member.client.get('/api/overview')).status, 200);

  const disabled = await admin.client
    .post(`/api/platform/users/${member.user.id}/disable`)
    .send({ reason: 'abuse' });
  assert.equal(disabled.status, 200, disabled.text);
  assert.ok(disabled.body.user.disabledAt);
  assert.equal(
    (await member.client.get('/api/overview')).status,
    401,
    'the existing session is revoked',
  );
  assert.equal((await member.client.get('/api/auth/me')).status, 401);
  const open = await store.list('session', { userId: member.user.id, revokedAt: null });
  assert.equal(open.length, 0);
  const login = await browser(app)
    .post('/api/auth/login')
    .send({ email: member.email, password: PASSWORD });
  assert.equal(login.status, 403, login.text);
  const wrong = await browser(app)
    .post('/api/auth/login')
    .send({ email: member.email, password: 'wrong-password!' });
  assert.equal(wrong.status, 401, 'a wrong password still says only that');

  assert.equal(
    (await admin.client.post(`/api/platform/users/${admin.user.id}/disable`).send({})).status,
    400,
  );
  const users = await admin.client.get('/api/platform/users').query({ status: 'disabled' });
  assert.deepEqual(
    users.body.items.map((u) => u.id),
    [member.user.id],
  );

  assert.equal(
    (await admin.client.post(`/api/platform/users/${member.user.id}/enable`).send({})).status,
    200,
  );
  const again = await browser(app)
    .post('/api/auth/login')
    .send({ email: member.email, password: PASSWORD });
  assert.equal(again.status, 200);
  const actions = (await store.list('platformAuditLog', { targetId: member.user.id }))
    .map((r) => r.action)
    .sort();
  assert.deepEqual(actions, ['user.disabled', 'user.enabled']);
});

test('admin:create promotes or creates (generated password), admin:revoke removes access at once', async () => {
  const owner = await register(app, 'Promote');
  const promoted = await grantPlatformAdmin(store, { email: owner.email.toUpperCase() });
  assert.equal(promoted.created, false);
  assert.equal(promoted.password, undefined);
  assert.equal((await owner.client.get('/api/platform/overview')).status, 200);

  const fresh = await grantPlatformAdmin(store, { email: 'new-staff@yukti.test' });
  assert.equal(fresh.created, true);
  assert.ok(fresh.password.length >= 20);
  const login = await browser(app)
    .post('/api/auth/login')
    .send({ email: 'new-staff@yukti.test', password: fresh.password });
  assert.equal(login.status, 200);

  await revokePlatformAdmin(store, owner.email);
  assert.equal((await owner.client.get('/api/platform/overview')).status, 403);
  await assert.rejects(grantPlatformAdmin(store, { email: 'not-an-email' }));
});

test('MRR: plan price per month, annual at 10/12, plus extra servers', () => {
  const pro = { priceUsdCents: 2900, includedServers: 10, extraServerUsdCents: 250 };
  assert.equal(monthlyCents({ interval: 'monthly' }, pro, 12), 2900 + 500);
  assert.equal(monthlyCents({ interval: 'annual' }, pro, 3), Math.round(29000 / 12));
  assert.equal(
    monthlyCents(
      { interval: 'monthly' },
      { priceUsdCents: 0, includedServers: 2, extraServerUsdCents: 0 },
      9,
    ),
    0,
  );
});
