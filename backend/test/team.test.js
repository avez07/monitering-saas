import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { digest } from '../src/lib/crypto.js';
import { outbox } from '../src/services/mail.js';
import { setup, closeStore, browser, register, addMember, PASSWORD } from './helpers.js';
import { setPlan, enrollServer } from './agent-helpers.js';

let store, app;
beforeEach(async () => {
  ({ store, app } = await setup());
});
after(closeStore);

const tokenFrom = (message) => message.text.match(/\/invite\/([\w-]+)/)[1];
const lastMail = (to) => [...outbox].reverse().find((m) => m.to === to);
const invite = (owner, email, role = 'viewer') => owner.client.post('/api/invites').send({ email, role });
const accept = (token, body = {}) => browser(app).post(`/api/invites/${token}/accept`).send(body);

test('invite a new person: email, public info, accept creates the account and a session', async () => {
  const owner = await register(app, 'Inviter');
  await setPlan(store, owner, 'starter');
  const created = await invite(owner, 'New.Person@Example.com', 'viewer');
  assert.equal(created.status, 201, created.text);
  assert.equal(created.body.status, 'pending');
  assert.equal(created.body.email, 'new.person@example.com');
  assert.equal(created.body.tokenHash, undefined);
  const mail = lastMail('new.person@example.com');
  assert.ok(mail, 'an email was sent');
  assert.match(mail.subject, /invited you/);
  const token = tokenFrom(mail);
  const row = await store.find('invite', { id: created.body.id });
  assert.equal(row.tokenHash, digest(token), 'only the hash is stored');
  assert.ok(Math.abs(row.expiresAt - Date.now() - 7 * 86400000) < 60000);

  const info = await request(app).get(`/api/invites/${token}`); // no cookie, no origin
  assert.equal(info.status, 200);
  assert.deepEqual(
    [info.body.email, info.body.role, info.body.userExists],
    ['new.person@example.com', 'viewer', false],
  );
  assert.match(info.body.organizationName, /Inviter Org/);

  assert.equal((await accept(token, { name: 'N', password: 'short' })).status, 400);
  const joined = await accept(token, { name: 'New Person', password: PASSWORD });
  assert.equal(joined.status, 201, joined.text);
  assert.equal(joined.body.role, 'viewer');
  assert.equal(joined.body.user.emailVerified, true);
  assert.ok(joined.headers['set-cookie']?.some((c) => c.startsWith('yuktiops_session=')));

  // The same client is now signed in to the inviter's organization.
  const client = browser(app);
  assert.equal((await client.post('/api/auth/login').send({ email: 'new.person@example.com', password: PASSWORD })).status, 200);
  const me = await client.get('/api/bootstrap');
  assert.equal(me.body.organization.id, owner.orgId);
  assert.equal(me.body.role, 'viewer');
  assert.equal((await owner.client.get('/api/invites')).body[0].status, 'accepted');
});

test('the invite link works once; replays are refused', async () => {
  const owner = await register(app, 'Once');
  await setPlan(store, owner, 'starter');
  await invite(owner, 'once@example.com');
  const token = tokenFrom(lastMail('once@example.com'));
  assert.equal((await accept(token, { name: 'Once', password: PASSWORD })).status, 201);
  const again = await accept(token, { name: 'Twice', password: PASSWORD });
  assert.equal(again.status, 410);
  assert.equal(again.body.reason, 'used');
  assert.equal((await request(app).get(`/api/invites/${token}`)).status, 410);
  assert.equal((await request(app).get('/api/invites/inv_unknown')).status, 404);
});

test('two simultaneous accepts cannot both succeed', async () => {
  const owner = await register(app, 'Race');
  await setPlan(store, owner, 'starter');
  await invite(owner, 'race@example.com');
  const token = tokenFrom(lastMail('race@example.com'));
  const results = await Promise.all(
    [1, 2].map((n) => accept(token, { name: `Racer ${n}`, password: PASSWORD })),
  );
  assert.equal(results.filter((r) => r.status === 201).length, 1, results.map((r) => r.status).join());
  assert.equal(await store.client.organizationMember.count({ where: { orgId: owner.orgId } }), 2);
});

test('an existing user joins while signed in as the invited email; the wrong account is refused', async () => {
  const owner = await register(app, 'Host');
  await setPlan(store, owner, 'starter');
  const guest = await register(app, 'Guest');
  const stranger = await register(app, 'Stranger');
  await invite(owner, guest.email, 'admin');
  const token = tokenFrom(lastMail(guest.email));
  assert.equal((await request(app).get(`/api/invites/${token}`)).body.userExists, true);

  const signedOut = await accept(token);
  assert.equal(signedOut.status, 401);
  assert.equal(signedOut.body.reason, 'signin_required');
  const wrong = await stranger.client.post(`/api/invites/${token}/accept`).send({});
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.reason, 'wrong_account');
  assert.equal(await store.client.organizationMember.count({ where: { orgId: owner.orgId } }), 1);

  const ok = await guest.client.post(`/api/invites/${token}/accept`).send({});
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.role, 'admin');
  const joined = await guest.client.get('/api/members').set('X-Organization-Id', owner.orgId);
  assert.equal(joined.status, 200, 'admin of the new organization');
  assert.ok(joined.body.some((m) => m.email === guest.email && m.role === 'admin'));
  // Their own organization is untouched.
  assert.equal((await guest.client.get('/api/members')).status, 200);
});

test('a signed-in user cannot use an invite meant for an email that has no account yet', async () => {
  const owner = await register(app, 'Mismatch');
  await setPlan(store, owner, 'starter');
  const other = await register(app, 'Someone');
  await invite(owner, 'fresh@example.com');
  const token = tokenFrom(lastMail('fresh@example.com'));
  const r = await other.client
    .post(`/api/invites/${token}/accept`)
    .send({ name: 'Someone', password: PASSWORD });
  assert.equal(r.status, 403);
  assert.equal(await store.find('user', { email: 'fresh@example.com' }), null);
});

test('expired, resent and cancelled invitations', async () => {
  const owner = await register(app, 'Life');
  await setPlan(store, owner, 'starter');
  const created = (await invite(owner, 'late@example.com')).body;
  const first = tokenFrom(lastMail('late@example.com'));
  await store.update('invite', created.id, { expiresAt: new Date(Date.now() - 1000) });
  const expired = await request(app).get(`/api/invites/${first}`);
  assert.equal(expired.status, 410);
  assert.equal(expired.body.reason, 'expired');
  assert.equal((await accept(first, { name: 'Late', password: PASSWORD })).status, 410);
  assert.equal((await owner.client.get('/api/invites')).body[0].status, 'expired');

  // A pending invitation can be resent: that issues a new token and extends the date.
  const fresh = (await invite(owner, 'resend@example.com')).body;
  const old = tokenFrom(lastMail('resend@example.com'));
  const resent = await owner.client.post(`/api/invites/${fresh.id}/resend`);
  assert.equal(resent.status, 200);
  const next = tokenFrom(lastMail('resend@example.com'));
  assert.notEqual(next, old);
  assert.equal((await request(app).get(`/api/invites/${old}`)).status, 404, 'the old link is dead');
  assert.equal((await request(app).get(`/api/invites/${next}`)).status, 200);

  assert.equal((await owner.client.delete(`/api/invites/${fresh.id}`)).status, 204);
  const gone = await request(app).get(`/api/invites/${next}`);
  assert.equal(gone.status, 410);
  assert.equal(gone.body.reason, 'revoked');
  assert.equal((await owner.client.post(`/api/invites/${fresh.id}/resend`)).status, 409);
});

test('the plan member limit counts members and open invitations', async () => {
  const owner = await register(app, 'Seats');
  const free = await invite(owner, 'a@example.com');
  assert.equal(free.status, 402, 'Free allows one member (the owner)');
  await setPlan(store, owner, 'starter'); // 3 members
  assert.equal((await invite(owner, 'a@example.com')).status, 201);
  assert.equal((await invite(owner, 'b@example.com')).status, 201);
  const full = await invite(owner, 'c@example.com');
  assert.equal(full.status, 402);
  assert.match(full.body.error, /members/);
  assert.equal((await invite(owner, 'a@example.com')).status, 409, 'already invited');
  // Cancelling frees the seat.
  const list = (await owner.client.get('/api/invites')).body;
  await owner.client.delete(`/api/invites/${list[0].id}`);
  assert.equal((await invite(owner, 'c@example.com')).status, 201);
  // Accept re-checks the limit: shrink the plan below the filled seats and the last accept is refused.
  await setPlan(store, owner, 'free');
  const token = tokenFrom(lastMail('c@example.com'));
  assert.equal((await accept(token, { name: 'Cee', password: PASSWORD })).status, 402);
});

test('existing members cannot be invited again, and owners cannot be invited as roles', async () => {
  const owner = await register(app, 'Dup');
  await setPlan(store, owner, 'pro');
  const viewer = await addMember(app, store, owner, { role: 'viewer' });
  assert.equal((await invite(owner, viewer.email)).status, 409);
  assert.equal((await invite(owner, 'x@example.com', 'owner')).status, 400);
  assert.equal((await invite(owner, 'x@example.com', 'editor')).status, 400);
  assert.equal((await invite(owner, 'not-an-email')).status, 400);
});

test('viewers are read-only and cannot manage the team', async () => {
  const owner = await register(app, 'ReadOnly');
  await setPlan(store, owner, 'pro');
  const server = await enrollServer(app, owner);
  const viewer = await addMember(app, store, owner, { role: 'viewer' });
  assert.equal((await viewer.client.get('/api/overview')).status, 200);
  assert.equal((await viewer.client.get('/api/servers')).status, 200);
  for (const [method, path, body] of [
    ['post', '/api/projects', { name: 'Nope' }],
    ['post', '/api/invites', { email: 'v@example.com', role: 'viewer' }],
    ['get', '/api/invites'],
    ['get', '/api/members'],
    ['delete', `/api/servers/${server.agentId}`],
    ['patch', `/api/servers/${server.agentId}`, { name: 'x' }],
    ['post', '/api/alerts/rules', { name: 'x', projectId: owner.project.id, metric: 'cpu', threshold: 1 }],
    ['post', '/api/billing/change', { planId: 'pro', interval: 'monthly' }],
    ['post', '/api/api-key'],
  ])
    assert.equal((await viewer.client[method](path).send(body)).status, 403, `${method} ${path}`);
});

test('admins manage the team and servers but not billing', async () => {
  const owner = await register(app, 'Admins');
  await setPlan(store, owner, 'pro');
  const admin = await addMember(app, store, owner, { role: 'admin' });
  assert.equal((await admin.client.post('/api/projects').send({ name: 'Second' })).status, 201);
  assert.equal((await invite(admin, 'new@example.com')).status, 201);
  assert.equal((await admin.client.get('/api/members')).status, 200);
  assert.equal((await admin.client.post('/api/billing/change').send({ planId: 'free', interval: 'monthly' })).status, 403);
  assert.equal((await admin.client.post('/api/billing/cancel')).status, 403);
});

test('owner protection and role rules for members', async () => {
  const owner = await register(app, 'Rules');
  await setPlan(store, owner, 'pro');
  const admin = await addMember(app, store, owner, { role: 'admin' });
  const admin2 = await addMember(app, store, owner, { role: 'admin' });
  const viewer = await addMember(app, store, owner, { role: 'viewer' });
  const ownerMembership = (await owner.client.get('/api/members')).body.find((m) => m.role === 'owner');
  assert.equal(ownerMembership.projectIds, undefined, 'projectIds are gone from responses');
  assert.equal((await owner.client.delete(`/api/members/${ownerMembership.id}`)).status, 403, 'owner cannot be removed');
  assert.equal((await admin.client.delete(`/api/members/${ownerMembership.id}`)).status, 403);
  assert.equal((await owner.client.patch(`/api/members/${ownerMembership.id}`).send({ role: 'viewer' })).status, 403);
  assert.equal((await admin.client.delete(`/api/members/${admin.membership.id}`)).status, 403, 'cannot remove yourself');
  // Only the owner manages admins.
  assert.equal((await admin.client.patch(`/api/members/${admin2.membership.id}`).send({ role: 'viewer' })).status, 403);
  assert.equal((await admin.client.patch(`/api/members/${viewer.membership.id}`).send({ role: 'admin' })).status, 403);
  assert.equal((await admin.client.delete(`/api/members/${admin2.membership.id}`)).status, 403);
  // Everything else is allowed, and unknown roles are not.
  assert.equal((await admin.client.patch(`/api/members/${viewer.membership.id}`).send({ role: 'viewer' })).status, 200);
  const promoted = await owner.client.patch(`/api/members/${viewer.membership.id}`).send({ role: 'admin' });
  assert.equal(promoted.status, 200);
  assert.equal(promoted.body.role, 'admin');
  assert.equal((await owner.client.patch(`/api/members/${viewer.membership.id}`).send({ role: 'editor' })).status, 400);
  assert.equal((await owner.client.patch(`/api/members/${viewer.membership.id}`).send({ role: 'owner' })).status, 400);
  assert.equal(
    (await owner.client.patch(`/api/members/${viewer.membership.id}`).send({ role: 'viewer', projectIds: ['x'] })).status,
    400,
  );
  const tellOtherOrg = await register(app, 'Elsewhere');
  assert.equal((await tellOtherOrg.client.delete(`/api/members/${viewer.membership.id}`)).status, 404);
});

test('a removed member loses access on their very next request, other organizations stay', async () => {
  const owner = await register(app, 'Removal');
  await setPlan(store, owner, 'starter');
  await invite(owner, 'leaver@example.com');
  const joined = await accept(tokenFrom(lastMail('leaver@example.com')), { name: 'Leaver', password: PASSWORD });
  assert.equal(joined.status, 201);
  const leaver = browser(app);
  await leaver.post('/api/auth/login').send({ email: 'leaver@example.com', password: PASSWORD });
  // Leaver also owns another organization by registering a second account? No: use a fresh membership instead.
  const second = await register(app, 'LeaverTwo');
  const user = await store.find('user', { email: 'leaver@example.com' });
  await store.create('organizationMember', { orgId: second.orgId, userId: user.id, role: 'viewer', projectIds: [] });
  assert.equal((await leaver.get('/api/overview').set('X-Organization-Id', owner.orgId)).status, 200);

  const member = (await owner.client.get('/api/members')).body.find((m) => m.email === 'leaver@example.com');
  assert.equal((await owner.client.delete(`/api/members/${member.id}`)).status, 204);
  assert.equal((await leaver.get('/api/overview').set('X-Organization-Id', owner.orgId)).status, 403);
  assert.equal((await leaver.get('/api/servers').set('X-Organization-Id', owner.orgId)).status, 403);
  assert.equal((await leaver.get('/api/overview').set('X-Organization-Id', second.orgId)).status, 200);
});

test('the old create-member-with-password path stays gone', async () => {
  const owner = await register(app, 'Gone');
  const r = await owner.client.post('/api/members').send({ name: 'F', email: 'f@example.com', password: PASSWORD, role: 'viewer' });
  assert.equal(r.status, 404);
  assert.equal(await store.find('user', { email: 'f@example.com' }), null);
});
