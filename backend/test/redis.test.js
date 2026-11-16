import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, secondInstance, closeStore, register, browser, PASSWORD } from './helpers.js';
import { enrollServer, ingest, bearer } from './agent-helpers.js';
import { Limits } from '../src/services/limits.js';

let a, b;
beforeEach(async () => {
  a = await setup();
  b = await secondInstance();
});
after(closeStore);

test('rate limits are shared by two API instances', async () => {
  const limits = [a.limits, b.limits];
  // 10 allowed per window in total, whichever instance counts the hit.
  for (let i = 0; i < 10; i++) await limits[i % 2].use('shared:key', 1, 10, 60);
  await assert.rejects(a.limits.use('shared:key', 1, 10, 60), { status: 429 });
  await assert.rejects(b.limits.use('shared:key', 1, 10, 60), { status: 429 });
  // Different keys and different windows stay independent.
  await b.limits.use('other:key', 1, 10, 60);
  await b.limits.use('shared:key', 1, 10, 30);
});

test('a lockout recorded on one instance cannot be bypassed through the other', async () => {
  for (let i = 0; i < 10; i++) await a.limits.record('login:fail:victim@example.com', 900);
  await assert.rejects(b.limits.assertUnder('login:fail:victim@example.com', 10, 900), {
    status: 429,
  });
  // Checking does not count.
  await a.limits.assertUnder('login:fail:fresh@example.com', 10, 900);
  await a.limits.assertUnder('login:fail:fresh@example.com', 10, 900);
});

test('login lockout holds across instances through the real routes', async () => {
  const owner = await register(a.app, 'Lock');
  for (let i = 0; i < 10; i++) {
    const wrong = await browser(i % 2 ? b.app : a.app)
      .post('/api/auth/login')
      .send({ email: owner.email, password: 'wrong-password-123' });
    assert.equal(wrong.status, 401);
  }
  // Even the right password is refused, on either instance.
  for (const app of [a.app, b.app]) {
    const locked = await browser(app)
      .post('/api/auth/login')
      .send({ email: owner.email, password: PASSWORD });
    assert.equal(locked.status, 429);
  }
});

test('revoking a server on instance A takes effect on instance B immediately', async () => {
  const owner = await register(a.app, 'Revoke');
  const s = await enrollServer(a.app, owner);
  // Warm B's cache.
  assert.equal((await ingest(b.app, s.credential)).status, 200);
  assert.equal((await ingest(b.app, s.credential)).status, 200);
  assert.equal((await owner.client.delete(`/api/servers/${s.agentId}`)).status, 204);
  assert.equal((await ingest(b.app, s.credential)).status, 401);
  assert.equal((await ingest(a.app, s.credential)).status, 401);
});

test('a limiter works when built with an explicit client and the failure counters survive other traffic', async () => {
  const limits = new Limits();
  for (let i = 0; i < 10; i++) await limits.record('login:fail:keep@example.com', 900);
  for (let i = 0; i < 300; i++) await limits.use(`ingest:agent-${i}`, 1, 30, 60);
  await assert.rejects(limits.assertUnder('login:fail:keep@example.com', 10, 900), { status: 429 });
});

test('bad API key attempts are limited across instances', async () => {
  const bad = (app) => request(app).post('/v1/register').set(bearer('yk_wrong')).send({});
  const seen = [];
  for (let i = 0; i < 22; i++) seen.push((await bad(i % 2 ? b.app : a.app)).status);
  assert.ok(seen.slice(0, 20).every((s) => s === 401), String(seen));
  assert.equal(seen[20], 429);
});
