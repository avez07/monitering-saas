import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, closeStore } from './helpers.js';
import { ingestQueue } from '../src/queues/ingest-queues.js';
import { metricsAllowed } from '../src/routes/metrics-internal.js';

after(async () => {
  delete process.env.METRICS_TOKEN;
  delete process.env.BULL_BOARD_USER;
  delete process.env.BULL_BOARD_PASSWORD;
  await closeStore();
});

test('/metrics is token protected and exposes queue and ingest gauges', async () => {
  const { app } = await setup();
  process.env.METRICS_TOKEN = 'metrics-token-for-tests';
  assert.equal((await request(app).get('/metrics')).status, 404);
  assert.equal((await request(app).get('/metrics').set('Authorization', 'Bearer nope')).status, 404);
  await ingestQueue().add('probe', { x: 1 }, { delay: 60000 });
  const ok = await request(app).get('/metrics').set('Authorization', 'Bearer metrics-token-for-tests');
  assert.equal(ok.status, 200, ok.text);
  assert.match(ok.text, /yuktiops_queue_jobs\{queue="ingest",state="delayed"\} 1/);
  assert.match(ok.text, /yuktiops_queue_lag_seconds\{queue="notify"\} 0/);
  assert.match(ok.text, /yuktiops_ingest_accepted_total [1-9]/);
  assert.match(ok.text, /yuktiops_notification_failures_1h 0/);
  await ingestQueue().drain(true);
});

test('without a token only direct loopback (no X-Forwarded-For) may read /metrics', () => {
  const req = (addr, headers = {}) => ({ headers, socket: { remoteAddress: addr } });
  assert.equal(metricsAllowed(req('127.0.0.1'), {}), true);
  assert.equal(metricsAllowed(req('::1'), {}), true);
  assert.equal(metricsAllowed(req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' }), {}), false);
  assert.equal(metricsAllowed(req('172.29.0.2'), {}), false);
});

test('Bull Board is disabled without credentials and needs basic auth with them', async () => {
  const { app } = await setup();
  assert.equal((await request(app).get('/admin/queues')).status, 404);
  process.env.BULL_BOARD_USER = 'staff';
  process.env.BULL_BOARD_PASSWORD = 'board-password-for-tests';
  assert.equal((await request(app).get('/admin/queues')).status, 401);
  assert.equal((await request(app).get('/admin/queues').auth('staff', 'wrong')).status, 401);
});
