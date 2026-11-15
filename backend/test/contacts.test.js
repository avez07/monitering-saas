import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { config } from '../src/config.js';
import { allowLoopbackForTests } from '../src/services/uptime.js';
import { testContact, signWebhook } from '../src/services/contacts.js';
import { setup, closeStore, register, addMember } from './helpers.js';
import { captureTransports, resetTransports, fakeServer } from './b2-helpers.js';

let store, app, sent;
const saved = {};
beforeEach(async () => {
  ({ store, app } = await setup());
  sent = captureTransports();
  for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_NAME', 'TELEGRAM_WEBHOOK_SECRET']) saved[k] = config[k];
  Object.assign(config, { TELEGRAM_BOT_TOKEN: '123:test-token', TELEGRAM_BOT_NAME: 'YuktiOpsTestBot', TELEGRAM_WEBHOOK_SECRET: 'hook-secret-for-tests' });
});
afterEach(() => {
  resetTransports();
  allowLoopbackForTests(false);
  Object.assign(config, saved);
});
after(closeStore);

const upgrade = async (owner, planId = 'starter') => {
  const sub = await store.find('subscription', { orgId: owner.orgId });
  await store.update('subscription', sub.id, { planId });
};
const post = (owner, body) => owner.client.post('/api/contacts').send(body);

test('every contact type delivers a test message through the transport, and secrets are masked', async () => {
  const owner = await register(app, 'Contacts');
  await upgrade(owner);
  const slackUrl = 'https://hooks.slack.com/services/T000/B000/SECRETSECRET1234';
  const discordUrl = 'https://discord.com/api/webhooks/123456/SECRETTOKEN-abcd';
  const hookUrl = 'https://hooks.example.org/yuktiops/abcdef';

  const email = await post(owner, { type: 'email', name: 'Ops mail', address: 'Ops@Example.com' });
  assert.equal(email.status, 201, email.text);
  assert.equal(email.body.target, 'ops@example.com');
  const slack = await post(owner, { type: 'slack', name: 'Slack', url: slackUrl });
  const discord = await post(owner, { type: 'discord', name: 'Discord', url: discordUrl });
  const hook = await post(owner, { type: 'webhook', name: 'Hook', url: hookUrl });
  for (const r of [slack, discord, hook]) assert.equal(r.status, 201, r.text);
  assert.match(hook.body.secret, /^whsec_/);
  // Telegram: link then bind.
  const tg = await post(owner, { type: 'telegram', name: 'Phone' });
  assert.equal(tg.status, 201, tg.text);
  assert.equal(tg.body.status, 'pending');
  assert.match(tg.body.link.url, /^https:\/\/t\.me\/YuktiOpsTestBot\?start=[\w-]{20,}$/);

  // Nothing returned later contains the full URL or the signing secret.
  const listed = await owner.client.get('/api/contacts');
  const text = JSON.stringify(listed.body);
  for (const secret of ['SECRETSECRET1234', 'SECRETTOKEN-abcd', 'abcdef', hook.body.secret, 'hooks.example.org/yuktiops'])
    assert.equal(text.includes(secret), false, `leaked ${secret}`);
  assert.equal(listed.body.items.find((c) => c.type === 'slack').target, 'hooks.slack.com/…1234');

  // Bind the Telegram chat through the bot webhook.
  const code = tg.body.link.code;
  const update = { message: { text: `/start ${code}`, chat: { id: 987654, username: 'avez' }, from: { first_name: 'Avez' } } };
  assert.equal((await request(app).post('/api/contacts/telegram/webhook').send(update)).status, 401);
  assert.equal(
    (await request(app).post('/api/contacts/telegram/webhook').set('X-Telegram-Bot-Api-Secret-Token', 'wrong').send(update)).status,
    401,
  );
  const bound = await request(app)
    .post('/api/contacts/telegram/webhook')
    .set('X-Telegram-Bot-Api-Secret-Token', 'hook-secret-for-tests')
    .send(update);
  assert.equal(bound.status, 200);
  const connected = (await owner.client.get('/api/contacts')).body.items.find((c) => c.type === 'telegram');
  assert.equal(connected.status, 'connected');
  assert.equal(connected.target, 'avez');
  assert.equal(JSON.parse(sent.http.at(-1).body).chat_id, 987654, 'bot confirms in the chat');
  // The code is single use.
  await request(app).post('/api/contacts/telegram/webhook').set('X-Telegram-Bot-Api-Secret-Token', 'hook-secret-for-tests').send(update);
  assert.equal(sent.http.filter((r) => r.url.includes('/sendMessage')).length, 2, 'second use only sends the expiry notice');
  assert.equal((await store.find('notificationChannel', { id: tg.body.id })).address, '987654');

  sent.http.length = 0;
  const run = async (contact) => (await owner.client.post(`/api/contacts/${contact.id}/test`)).body;
  assert.deepEqual(await run(email.body), { ok: true });
  assert.equal(sent.email[0].to, 'ops@example.com');
  assert.deepEqual(await run(tg.body), { ok: true });
  assert.equal(sent.http[0].url, 'https://api.telegram.org/bot123:test-token/sendMessage');
  assert.equal(JSON.parse(sent.http[0].body).chat_id, '987654');
  assert.deepEqual(await run(slack.body), { ok: true });
  assert.equal(sent.http[1].url, slackUrl);
  assert.ok(JSON.parse(sent.http[1].body).text.includes('test'));
  assert.deepEqual(await run(discord.body), { ok: true });
  assert.equal(sent.http[2].url, discordUrl);
  assert.ok(JSON.parse(sent.http[2].body).content.includes('test'));
  assert.deepEqual(await run(hook.body), { ok: true });
  const call = sent.http[3];
  assert.equal(call.url, hookUrl);
  const expected = createHmac('sha256', hook.body.secret)
    .update(`${call.headers['x-yuktiops-timestamp']}.${call.body}`)
    .digest('hex');
  assert.equal(call.headers['x-yuktiops-signature'], `sha256=${expected}`);
  assert.equal(JSON.parse(call.body).event, 'test');
  assert.equal(signWebhook('s', '1', 'b'), `sha256=${createHmac('sha256', 's').update('1.b').digest('hex')}`);

  // A destination that refuses is reported in plain words and remembered.
  resetTransports();
  captureTransports({ httpStatus: 500 });
  const failed = await owner.client.post(`/api/contacts/${slack.body.id}/test`);
  assert.equal(failed.body.ok, false);
  assert.match(failed.body.error, /Slack refused/);
  assert.equal((await owner.client.get('/api/contacts')).body.items.find((c) => c.id === slack.body.id).lastTest.ok, false);
});

test('the Free plan only allows Email and Telegram; roles are enforced', async () => {
  const owner = await register(app, 'FreePlan');
  for (const body of [
    { type: 'slack', name: 'Slack', url: 'https://hooks.slack.com/services/T/B/x' },
    { type: 'discord', name: 'Disc', url: 'https://discord.com/api/webhooks/1/x' },
    { type: 'webhook', name: 'Hook', url: 'https://example.org/hook' },
  ]) {
    const res = await post(owner, body);
    assert.equal(res.status, 402, body.type);
    assert.match(res.body.error, /Free plan/);
  }
  assert.equal((await post(owner, { type: 'email', name: 'Mail', address: 'a@example.com' })).status, 201);
  assert.deepEqual((await owner.client.get('/api/contacts')).body.allowedTypes, ['email', 'telegram']);
  await upgrade(owner, 'pro');
  assert.equal((await post(owner, { type: 'webhook', name: 'Hook', url: 'https://example.org/hook' })).status, 201);
  const viewer = await addMember(app, store, owner, { role: 'viewer' });
  assert.equal((await viewer.client.get('/api/contacts')).status, 200);
  assert.equal((await post(viewer, { type: 'email', name: 'Nope', address: 'n@example.com' })).status, 403);
});

test('webhook destinations are guarded against private addresses and redirects', async () => {
  const owner = await register(app, 'Guard');
  await upgrade(owner, 'pro');
  for (const url of ['http://127.0.0.1/hook', 'http://169.254.169.254/latest', 'http://localhost/x', 'http://[::1]/x', 'ftp://example.org/x'])
    assert.equal((await post(owner, { type: 'webhook', name: 'Bad', url })).status, 400, url);
  assert.equal((await post(owner, { type: 'slack', name: 'Bad', url: 'https://evil.example.org/services/x' })).status, 400);
  assert.equal((await post(owner, { type: 'discord', name: 'Bad', url: 'https://discord.com.evil.org/api/webhooks/1/x' })).status, 400);

  // Send time: a hostname that now points at a private address is refused with the real transport.
  resetTransports();
  const target = await fakeServer((req, res) => res.end('ok'));
  try {
    const row = await store.create('notificationChannel', {
      orgId: owner.orgId, name: 'Sneaky', type: 'webhook', address: target.url('/hook'), secret: 's', enabled: true,
    });
    const refused = await testContact(store, row);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /not allowed/);
    assert.equal(target.hits.length, 0, 'nothing reached the private server');

    // With the test hook the real transport signs and delivers; redirects are never followed.
    allowLoopbackForTests(true);
    const ok = await testContact(store, row);
    assert.deepEqual(ok, { ok: true });
    const hit = target.hits[0];
    assert.equal(hit.method, 'POST');
    assert.match(hit.headers['x-yuktiops-signature'], /^sha256=[0-9a-f]{64}$/);
    assert.ok(Math.abs(Number(hit.headers['x-yuktiops-timestamp']) - Date.now() / 1000) < 30);
  } finally {
    await target.close();
  }
  const landing = await fakeServer((req, res) => res.end('landed'));
  const redirector = await fakeServer((req, res) => {
    res.writeHead(302, { location: landing.url('/inner') });
    res.end();
  });
  try {
    allowLoopbackForTests(true);
    const row = await store.create('notificationChannel', {
      orgId: owner.orgId, name: 'Redirect', type: 'webhook', address: redirector.url('/hook'), secret: 's', enabled: true,
    });
    const result = await testContact(store, row);
    assert.equal(result.ok, false);
    assert.equal(landing.hits.length, 0, 'the redirect was not followed');
  } finally {
    await redirector.close();
    await landing.close();
  }
});

test('webhook signature verifies against the raw body on the receiving side', async () => {
  const owner = await register(app, 'Verify');
  await upgrade(owner, 'pro');
  const received = [];
  const receiver = await fakeServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push({ raw, headers: req.headers });
      res.end('ok');
    });
  });
  try {
    resetTransports();
    allowLoopbackForTests(true);
    const row = await store.create('notificationChannel', {
      orgId: owner.orgId, name: 'Recv', type: 'webhook', address: receiver.url('/in'), secret: 'whsec_known', enabled: true,
    });
    assert.deepEqual(await testContact(store, row), { ok: true });
    const { raw, headers } = received[0];
    const expected = createHmac('sha256', 'whsec_known').update(`${headers['x-yuktiops-timestamp']}.${raw}`).digest('hex');
    assert.equal(headers['x-yuktiops-signature'], `sha256=${expected}`);
    assert.equal(JSON.parse(raw).event, 'test');
  } finally {
    await receiver.close();
  }
});

test('an expired Telegram link is rejected and contacts can be edited and deleted', async () => {
  const owner = await register(app, 'Telegram');
  const tg = await post(owner, { type: 'telegram', name: 'Late' });
  await store.update('notificationChannel', tg.body.id, { linkExpiresAt: new Date(Date.now() - 1000) });
  const update = { message: { text: `/start ${tg.body.link.code}`, chat: { id: 5 } } };
  await request(app).post('/api/contacts/telegram/webhook').set('X-Telegram-Bot-Api-Secret-Token', 'hook-secret-for-tests').send(update);
  assert.equal((await store.find('notificationChannel', { id: tg.body.id })).address, '');
  const fresh = await owner.client.post(`/api/contacts/${tg.body.id}/telegram-link`);
  assert.equal(fresh.status, 200);
  assert.notEqual(fresh.body.code, tg.body.link.code);
  assert.equal((await owner.client.patch(`/api/contacts/${tg.body.id}`).send({ enabled: true })).status, 400, 'cannot enable before linking');

  const mail = await post(owner, { type: 'email', name: 'Mail', address: 'm@example.com' });
  const rules = (await owner.client.get('/api/alerts/rules')).body.items;
  await owner.client.patch(`/api/alerts/rules/${rules[0].id}`).send({ contactIds: [mail.body.id] });
  const renamed = await owner.client.patch(`/api/contacts/${mail.body.id}`).send({ name: 'Renamed', enabled: false });
  assert.equal(renamed.body.name, 'Renamed');
  assert.equal(renamed.body.enabled, false);
  assert.equal((await owner.client.delete(`/api/contacts/${mail.body.id}`)).status, 204);
  assert.deepEqual((await owner.client.get('/api/alerts/rules')).body.items.find((r) => r.id === rules[0].id).contactIds, []);
  // No bot configured: Telegram is unavailable.
  config.TELEGRAM_BOT_TOKEN = '';
  assert.equal((await post(owner, { type: 'telegram', name: 'No bot' })).status, 503);
  assert.equal((await owner.client.get('/api/contacts')).body.telegram.configured, false);
});
