import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { digest } from '../src/lib/crypto.js';
import { outbox } from '../src/services/mail.js';
import { setup, closeStore, browser, register, PASSWORD } from './helpers.js';

let store, app;
beforeEach(async () => {
  ({ store, app } = await setup());
});
after(closeStore);

const mailTo = (to) => outbox.filter((m) => m.to === to);
const tokenOf = (mail, name) => mail.text.match(new RegExp(`${name}\\?token=([\\w-]+)`))[1];
const post = (path, body) => browser(app).post(`/api/auth${path}`).send(body);

test('registration emails a verification link; /me shows emailVerified; the link works once', async () => {
  const owner = await register(app, 'Verify');
  const me = await owner.client.get('/api/auth/me');
  assert.equal(me.body.user.emailVerified, false);
  assert.equal(me.body.user.passwordHash, undefined);
  // Unverified users can still use the product.
  assert.equal((await owner.client.get('/api/overview')).status, 200);

  const [mail] = mailTo(owner.email);
  assert.match(mail.subject, /Confirm/);
  const token = tokenOf(mail, 'verify-email');
  const stored = await store.client.accountToken.findFirst({ where: { kind: 'email_verify' } });
  assert.equal(stored.tokenHash, digest(token), 'only the hash is stored');

  assert.equal((await post('/verify-email', { token: 'vfy_wrong' })).status, 400);
  const ok = await post('/verify-email', { token });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { verified: true });
  assert.equal((await owner.client.get('/api/auth/me')).body.user.emailVerified, true);
  assert.equal((await post('/verify-email', { token })).status, 400, 'single use');
});

test('verification links expire, and resending replaces the old link', async () => {
  const owner = await register(app, 'Resend');
  const first = tokenOf(mailTo(owner.email)[0], 'verify-email');
  const resent = await owner.client.post('/api/auth/resend-verification');
  assert.deepEqual(resent.body, { sent: true });
  const second = tokenOf(mailTo(owner.email)[1], 'verify-email');
  assert.notEqual(first, second);
  assert.equal((await post('/verify-email', { token: first })).status, 400, 'the older link is dead');
  await store.client.accountToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await post('/verify-email', { token: second })).status, 400, 'expired');
  assert.equal((await browser(app).post('/api/auth/resend-verification')).status, 401);

  // Rate limit: three per hour.
  // One resend happened above; the third is the last allowed in an hour.
  assert.equal((await owner.client.post('/api/auth/resend-verification')).status, 200);
  assert.equal((await owner.client.post('/api/auth/resend-verification')).status, 200);
  assert.equal((await owner.client.post('/api/auth/resend-verification')).status, 429);
  const verified = await store.find('user', { email: owner.email });
  await store.update('user', verified.id, { emailVerifiedAt: new Date() });
  assert.deepEqual((await owner.client.post('/api/auth/resend-verification')).body, {
    sent: false,
    alreadyVerified: true,
  });
});

test('forgot-password answers 200 for everyone and only emails real accounts', async () => {
  const owner = await register(app, 'Forgot');
  const before = outbox.length;
  const unknown = await post('/forgot-password', { email: 'nobody@example.com' });
  const known = await post('/forgot-password', { email: owner.email.toUpperCase() });
  assert.equal(unknown.status, 200);
  assert.equal(known.status, 200);
  assert.deepEqual(unknown.body, known.body);
  assert.equal(outbox.length, before + 1);
  assert.equal(mailTo('nobody@example.com').length, 0);
  assert.equal((await post('/forgot-password', { email: 'not-an-email' })).status, 400);
});

test('forgot-password is rate limited per email', async () => {
  const owner = await register(app, 'Limited');
  for (let i = 0; i < 3; i++) assert.equal((await post('/forgot-password', { email: owner.email })).status, 200);
  assert.equal((await post('/forgot-password', { email: owner.email })).status, 429);
});

test('reset-password: single use, one hour, revokes every session', async () => {
  const owner = await register(app, 'Reset');
  const other = browser(app);
  await other.post('/api/auth/login').send({ email: owner.email, password: PASSWORD });
  assert.equal((await owner.client.get('/api/overview')).status, 200);

  await post('/forgot-password', { email: owner.email });
  const mail = mailTo(owner.email).at(-1);
  assert.match(mail.subject, /Reset/);
  const token = tokenOf(mail, 'reset-password');
  const stored = await store.client.accountToken.findFirst({ where: { kind: 'password_reset' } });
  assert.equal(stored.tokenHash, digest(token));
  assert.ok(Math.abs(stored.expiresAt - Date.now() - 3600000) < 60000, 'valid for one hour');

  assert.equal((await post('/reset-password', { token, password: 'short' })).status, 400);
  assert.equal((await post('/reset-password', { token: 'rst_wrong', password: 'a-brand-new-password' })).status, 400);
  const done = await post('/reset-password', { token, password: 'a-brand-new-password' });
  assert.equal(done.status, 200);
  assert.deepEqual(done.body, { reset: true });

  assert.equal((await owner.client.get('/api/overview')).status, 401, 'session 1 revoked');
  assert.equal((await other.get('/api/overview')).status, 401, 'session 2 revoked');
  assert.equal((await post('/login', { email: owner.email, password: PASSWORD })).status, 401);
  assert.equal((await post('/login', { email: owner.email, password: 'a-brand-new-password' })).status, 200);
  assert.equal((await post('/reset-password', { token, password: 'another-new-password' })).status, 400, 'single use');
});

test('an expired reset link, and an older link after a new request, are refused', async () => {
  const owner = await register(app, 'Expire');
  await post('/forgot-password', { email: owner.email });
  const first = tokenOf(mailTo(owner.email).at(-1), 'reset-password');
  await post('/forgot-password', { email: owner.email });
  const second = tokenOf(mailTo(owner.email).at(-1), 'reset-password');
  assert.equal((await post('/reset-password', { token: first, password: 'a-brand-new-password' })).status, 400);
  await store.client.accountToken.updateMany({
    where: { kind: 'password_reset' },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal((await post('/reset-password', { token: second, password: 'a-brand-new-password' })).status, 400);
  assert.equal((await post('/login', { email: owner.email, password: PASSWORD })).status, 200, 'password unchanged');
});

test('account routes reject cross-site requests', async () => {
  const r = await request(app).post('/api/auth/forgot-password').set('Origin', 'https://evil.example').send({ email: 'a@b.co' });
  assert.equal(r.status, 403);
});
