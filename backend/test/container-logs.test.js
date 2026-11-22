import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import request from 'supertest';
import { setup, closeStore, register, addMember } from './helpers.js';
import { enrollServer, ingest, payload, sample, bearer } from './agent-helpers.js';
import { configureClickhouse, clickhouse, clickhouseReachable, closeClickhouse, ensureSchema, tables } from '../src/lib/clickhouse.js';
import { runQueueOnce } from '../src/queues/factory.js';
import { processOtelJob, setOtelBackpressure, clearOtelSettingsCache, OTEL_QUEUE } from '../src/queues/otel.js';
import { setQuotaOverride, readUsage } from '../src/services/otel-usage.js';
import { configForAgent } from '../src/services/agent-config.js';

// The read tests need ClickHouse (docker compose up -d clickhouse) and use a throwaway database, like otel.test.js.
const DATABASE = `yuktiops_test_clogs_${randomBytes(4).toString('hex')}`;
const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || 'http://localhost:8123';
configureClickhouse({ database: DATABASE });
const available = await clickhouseReachable();
const needsClickhouse = { skip: available ? false : 'ClickHouse is not reachable (docker compose up -d clickhouse)' };
if (available) await ensureSchema();

let store, app;
beforeEach(async () => {
  ({ store, app } = await setup());
  setQuotaOverride(null);
  setOtelBackpressure({ maxWaiting: 2000 });
  clearOtelSettingsCache();
  configureClickhouse({ url: CLICKHOUSE_URL });
  if (available) await clickhouse().command({ query: `TRUNCATE TABLE ${tables.logs}` });
});
after(async () => {
  setQuotaOverride(null);
  configureClickhouse({ url: CLICKHOUSE_URL });
  if (available) await clickhouse().command({ query: `DROP DATABASE IF EXISTS \`${DATABASE}\`` });
  await closeClickhouse();
  await closeStore();
});

const DOCKER_ID = 'abc123def456aaaabbbbccccdddd';
async function fixture(name = 'Logs') {
  const owner = await register(app, name);
  const server = await enrollServer(app, owner, 1);
  const containers = [{ id: DOCKER_ID, name: 'web', image: 'nginx:1.27', state: 'running', restartCount: 0 }];
  const res = await ingest(app, server.credential, payload([sample()], { containers }));
  assert.equal(res.status, 202, res.text);
  const list = await owner.client.get('/api/containers');
  const container = list.body.items.find((c) => c.name === 'web');
  assert.ok(container, 'the container was recorded');
  return { owner, server, container };
}
const attr = (key, value) => ({ key, value: { stringValue: String(value) } });
const nanos = (ms) => String(BigInt(Math.round(ms)) * 1000000n);
const logsBody = (records, { agent = 'spoofed-agent', name = 'web', id = DOCKER_ID } = {}) => ({
  resourceLogs: [
    {
      resource: {
        attributes: [
          attr('service.name', name),
          attr('container.name', name),
          attr('container.id', id),
          attr('container.image', 'nginx:1.27'),
          attr('host.name', 'host-1'),
          attr('yk.agent', agent),
          attr('yk.source', 'docker'),
        ],
      },
      scopeLogs: [{ scope: { name: 'yuktiops-agent' }, logRecords: records }],
    },
  ],
});
const line = (ms, text, { stream = 'stdout', severityText = '' } = {}) => ({
  timeUnixNano: nanos(ms),
  severityText,
  body: { stringValue: text },
  attributes: [attr('log.iostream', stream)],
});
const sendLogs = (credential, body, path = '/v1/otlp/logs') =>
  request(app).post(path).set(bearer(credential)).set('Content-Type', 'application/json').send(body);
const drain = () => runQueueOnce(OTEL_QUEUE, (job) => processOtelJob(store, job.data));

test('PATCH /api/containers/:id/logs edits containerLogs include/exclude and bumps the agent settings', async () => {
  const { owner, server, container } = await fixture('Toggle');
  assert.equal((await owner.client.get(`/api/containers/${container.id}`)).body.logsEnabled, false);
  const on = await owner.client.patch(`/api/containers/${container.id}/logs`).send({ enabled: true });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.body.enabled, true);
  const agent = await store.find('agent', { id: server.agentId });
  let settings = (await configForAgent(store, agent)).settings;
  assert.deepEqual(settings.collectors.containerLogs, { enabled: true, include: ['web'], exclude: [] });
  assert.equal((await owner.client.get(`/api/containers/${container.id}`)).body.logsEnabled, true);
  const config = await request(app).get('/v1/config').set(bearer(server.credential));
  assert.deepEqual(config.body.settings.collectors.containerLogs.include, ['web']);

  const off = await owner.client.patch(`/api/containers/${container.id}/logs`).send({ enabled: false });
  assert.equal(off.body.enabled, false);
  settings = (await configForAgent(store, await store.find('agent', { id: server.agentId }))).settings;
  assert.deepEqual(settings.collectors.containerLogs, { enabled: false, include: [], exclude: ['web'] });

  assert.equal((await owner.client.patch(`/api/containers/${container.id}/logs`).send({ enabled: 'yes' })).status, 400);
  const viewer = await addMember(app, store, owner, { role: 'viewer' });
  assert.equal((await viewer.client.patch(`/api/containers/${container.id}/logs`).send({ enabled: true })).status, 403);
  const other = await register(app, 'Other');
  assert.equal((await other.client.get(`/api/containers/${container.id}/logs`)).status, 404);
});

test('agent-credential OTLP logs: accepted, counted, 401 for bad credentials, 429 logs_quota when the quota is used up', async () => {
  const { owner, server } = await fixture('Ingest');
  const accepted = await sendLogs(server.credential, logsBody([line(Date.now(), 'hello')]));
  assert.equal(accepted.status, 200, accepted.text);
  assert.ok((await readUsage(owner.orgId)).bySignal.logs > 0, 'bytes count against the telemetry quota');
  // The agent sends gzip-compressed OTLP/JSON.
  const gz = await request(app)
    .post('/v1/otlp/logs')
    .set(bearer(server.credential))
    .set('Content-Type', 'application/json')
    .set('Content-Encoding', 'gzip')
    .serialize((raw) => raw) // send the gzip bytes as they are
    .send(gzipSync(Buffer.from(JSON.stringify(logsBody([line(Date.now(), 'zipped')])))));
  assert.equal(gz.status, 200, gz.text);
  // The standard /v1/logs path takes the agent credential too.
  assert.equal((await sendLogs(server.credential, logsBody([line(Date.now(), 'again')]), '/v1/logs')).status, 200);
  assert.equal((await sendLogs('agent_wrong', logsBody([line(Date.now(), 'x')]))).status, 401);

  setQuotaOverride(1);
  const over = await sendLogs(server.credential, logsBody([line(Date.now(), 'too much')]));
  assert.equal(over.status, 429);
  assert.equal(over.body.code, 'logs_quota');
  assert.ok(over.headers['retry-after']);
});

test('GET /api/containers/:id/logs reads the container lines (filters, live tail)', needsClickhouse, async () => {
  const { owner, server, container } = await fixture('Read');
  const t0 = Date.now() - 60000;
  const res = await sendLogs(
    server.credential,
    logsBody([
      line(t0, 'starting nginx'),
      line(t0 + 1000, 'GET /health 200', { severityText: 'INFO' }),
      line(t0 + 2000, 'upstream timed out', { stream: 'stderr', severityText: 'ERROR' }),
      line(t0 + 3000, 'slow request', { severityText: 'WARN' }),
    ]),
  );
  assert.equal(res.status, 200, res.text);
  // Another container's lines and lines claiming another agent stay out.
  await sendLogs(server.credential, logsBody([line(t0 + 500, 'db line')], { name: 'db', id: 'fff999eee888' }));
  await drain();

  const all = await owner.client.get(`/api/containers/${container.id}/logs`);
  assert.equal(all.status, 200, all.text);
  assert.deepEqual(
    all.body.items.map((i) => i.message),
    ['starting nginx', 'GET /health 200', 'upstream timed out', 'slow request'],
  );
  assert.deepEqual(all.body.items[2], { time: all.body.items[2].time, stream: 'stderr', level: 'error', message: 'upstream timed out' });
  assert.match(all.body.items[0].time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/);
  assert.equal(all.body.nextSince, all.body.items.at(-1).time);

  const errors = await owner.client.get(`/api/containers/${container.id}/logs`).query({ level: 'error' });
  assert.deepEqual(errors.body.items.map((i) => i.message), ['upstream timed out']);
  const stderr = await owner.client.get(`/api/containers/${container.id}/logs`).query({ stream: 'stderr' });
  assert.equal(stderr.body.items.length, 1);
  const search = await owner.client.get(`/api/containers/${container.id}/logs`).query({ q: 'HEALTH' });
  assert.deepEqual(search.body.items.map((i) => i.message), ['GET /health 200']);
  const newest = await owner.client.get(`/api/containers/${container.id}/logs`).query({ limit: 2 });
  assert.deepEqual(newest.body.items.map((i) => i.message), ['upstream timed out', 'slow request']);

  // Live tail: after nextSince only new lines come back.
  const since = all.body.nextSince;
  assert.deepEqual((await owner.client.get(`/api/containers/${container.id}/logs`).query({ since })).body.items, []);
  await sendLogs(server.credential, logsBody([line(t0 + 5000, 'new line')]));
  await drain();
  const tail = await owner.client.get(`/api/containers/${container.id}/logs`).query({ since });
  assert.deepEqual(tail.body.items.map((i) => i.message), ['new line']);
  assert.equal((await owner.client.get(`/api/containers/${container.id}/logs`).query({ since: 'yesterday' })).status, 400);
});

test('GET /api/containers/:id/logs answers a structured 503 when ClickHouse is down', async () => {
  const { owner, container } = await fixture('Down');
  configureClickhouse({ url: 'http://127.0.0.1:1' });
  const res = await owner.client.get(`/api/containers/${container.id}/logs`);
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'telemetry_unavailable');
  assert.equal(res.body.service, 'clickhouse');
});
