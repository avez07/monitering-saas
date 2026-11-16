import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import request from 'supertest';
import { setup, closeStore, register, addMember } from './helpers.js';
import { configureClickhouse, clickhouse, clickhouseReachable, closeClickhouse, ensureSchema, select, tables, clickhouseDatabase } from '../src/lib/clickhouse.js';
import { runQueueOnce } from '../src/queues/factory.js';
import { processOtelJob, setOtelBackpressure, clearOtelSettingsCache, OTEL_QUEUE } from '../src/queues/otel.js';
import { encodeRequest } from '../src/services/otel-proto.js';
import { setQuotaOverride } from '../src/services/otel-usage.js';
import { evaluateAlerts } from '../src/services/workers.js';
import { outbox } from '../src/services/mail.js';

// These tests need ClickHouse (docker compose up -d clickhouse). They use a throwaway database.
const DATABASE = `yuktiops_test_otel_${randomBytes(4).toString('hex')}`;
configureClickhouse({ database: DATABASE });
const available = await clickhouseReachable();
const opts = { skip: available ? false : 'ClickHouse is not reachable (docker compose up -d clickhouse)' };

let store, app;
before(async () => {
  if (available) await ensureSchema();
});
beforeEach(async () => {
  ({ store, app } = await setup());
  setQuotaOverride(null);
  setOtelBackpressure({ maxWaiting: 2000 });
  clearOtelSettingsCache();
  if (available) await Promise.all([tables.traces, tables.logs, tables.red].map((t) => clickhouse().command({ query: `TRUNCATE TABLE ${t}` })));
});
after(async () => {
  if (available) await clickhouse().command({ query: `DROP DATABASE IF EXISTS \`${DATABASE}\`` });
  await closeClickhouse();
  await closeStore();
});

const hex = (n) => randomBytes(n).toString('hex');
const nanos = (ms) => String(BigInt(Math.round(ms)) * 1000000n);
const attr = (key, value) => ({ key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: String(value) } });

/** One resource with the given spans (OTLP/JSON shape). */
function tracesJson(service, spans, resourceAttributes = []) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [attr('service.name', service), ...resourceAttributes] },
        scopeSpans: [{ scope: { name: 'test-scope', version: '1.0' }, spans }],
      },
    ],
  };
}
function span({ traceId = hex(16), spanId = hex(8), parentSpanId = '', name = 'GET /orders', kind = 2, startMs = Date.now() - 5000, durationMs = 50, error = false, attributes = [], events = [] } = {}) {
  return {
    traceId,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name,
    kind,
    startTimeUnixNano: nanos(startMs),
    endTimeUnixNano: nanos(startMs + durationMs),
    attributes,
    events,
    status: error ? { code: 2, message: 'boom' } : { code: 1 },
  };
}
/** The same request with ids converted for protobuf (bytes arrive as base64 in fromObject). */
function toProtoShape(request) {
  const copy = structuredClone(request);
  for (const rs of copy.resourceSpans ?? [])
    for (const ss of rs.scopeSpans)
      for (const s of ss.spans) {
        s.traceId = Buffer.from(s.traceId, 'hex').toString('base64');
        s.spanId = Buffer.from(s.spanId, 'hex').toString('base64');
        if (s.parentSpanId) s.parentSpanId = Buffer.from(s.parentSpanId, 'hex').toString('base64');
      }
  return copy;
}
const logsJson = (service, records) => ({
  resourceLogs: [{ resource: { attributes: [attr('service.name', service)] }, scopeLogs: [{ scope: { name: 'logger' }, logRecords: records }] }],
});
const logRecord = ({ body, severityNumber = 9, timeMs = Date.now() - 2000, traceId, spanId, attributes = [] }) => ({
  timeUnixNano: nanos(timeMs),
  severityNumber,
  body: { stringValue: body },
  attributes,
  ...(traceId ? { traceId, spanId } : {}),
});

async function newOrg(name = 'Otel') {
  const owner = await register(app, name);
  const created = await owner.client.post('/api/telemetry-keys').send({ name: 'production' });
  assert.equal(created.status, 201, created.text);
  return { owner, key: created.body.key, keyId: created.body.id };
}
const send = (key, path, body, { type = 'json', gzip = false } = {}) => {
  const r = request(app).post(path).set('x-yuktiops-key', key).serialize((b) => b); // bodies are sent exactly as given
  if (type === 'json') r.set('Content-Type', 'application/json');
  else r.set('Content-Type', 'application/x-protobuf');
  if (gzip) r.set('Content-Encoding', 'gzip');
  const payload = type === 'json' ? JSON.stringify(body) : body;
  return r.send(gzip ? gzipSync(Buffer.isBuffer(payload) ? payload : Buffer.from(payload)) : payload);
};
const sendJson = (key, path, body, o) => send(key, path, body, { ...o, type: 'json' });
const sendProto = (key, signal, object, o) => send(key, `/v1/${signal}`, encodeRequest(signal, object), { ...o, type: 'proto' });
/** Run the otel worker over everything queued. */
const drain = () => runQueueOnce(OTEL_QUEUE, (job) => processOtelJob(store, job.data));

test('key kinds are isolated: install keys cannot send OTLP and telemetry keys cannot register servers', opts, async () => {
  const { owner, key } = await newOrg('Kinds');
  const install = await owner.client.post('/api/api-key/regenerate').send();
  assert.equal(install.status, 201);
  const body = tracesJson('svc', [span()]);
  assert.equal((await sendJson(install.body.key, '/v1/traces', body)).status, 401, 'install key is not a telemetry key');
  assert.equal((await request(app).post('/v1/traces').set('Content-Type', 'application/json').send(body)).status, 401, 'no key');
  assert.equal((await sendJson(key, '/v1/traces', body)).status, 200);

  const register1 = await request(app).post('/v1/register').set('Authorization', `Bearer ${key}`).send({});
  assert.equal(register1.status, 401, 'a telemetry key does not work as an install key');
  const asHeader = await request(app).post('/v1/traces').set('Authorization', `Bearer ${key}`).set('Content-Type', 'application/json').send(body);
  assert.equal(asHeader.status, 401, 'only the x-yuktiops-key header is read');

  // The install key endpoints ignore telemetry keys entirely, and regenerating does not revoke them.
  const regen = await owner.client.post('/api/api-key/regenerate').send();
  assert.equal(regen.status, 201);
  assert.equal((await sendJson(key, '/v1/traces', body)).status, 200, 'telemetry key survives install key regeneration');
  const current = await owner.client.get('/api/api-key');
  assert.equal(current.body.key.prefix, regen.body.prefix);
  assert.ok(String(key).startsWith('yk_otel_'));
  const listed = await owner.client.get('/api/telemetry-keys');
  assert.equal(listed.body.items.length, 1);
  assert.equal(listed.body.items[0].key, undefined, 'the raw key is never listed');
});

test('telemetry keys: admin only, revoke is immediate, viewers cannot create', opts, async () => {
  const { owner, key, keyId } = await newOrg('Revoke');
  const viewer = await addMember(app, store, owner, { role: 'viewer' });
  assert.equal((await viewer.client.post('/api/telemetry-keys').send({ name: 'x' })).status, 403);
  assert.equal((await viewer.client.get('/api/telemetry-keys')).status, 403);
  assert.equal((await sendJson(key, '/v1/traces', tracesJson('svc', [span()]))).status, 200);
  assert.equal((await owner.client.delete(`/api/telemetry-keys/${keyId}`)).status, 200);
  assert.equal((await sendJson(key, '/v1/traces', tracesJson('svc', [span()]))).status, 401, 'the 60 s key cache is cleared on revoke');
  assert.equal((await owner.client.delete(`/api/telemetry-keys/${keyId}`)).status, 404);
});

test('OTLP JSON and protobuf (gzip too) traces are accepted and queryable by service, last hour', opts, async () => {
  const { owner, key } = await newOrg('Traces');
  const traceA = hex(16);
  const root = hex(8);
  const jsonBody = tracesJson('checkout-api', [
    span({ traceId: traceA, spanId: root, name: 'GET /orders', durationMs: 120, attributes: [attr('http.method', 'GET'), attr('order.id', 42)] }),
    span({ traceId: traceA, spanId: hex(8), parentSpanId: root, name: 'SELECT orders', kind: 3, durationMs: 40, startMs: Date.now() - 4990,
      error: true, events: [{ timeUnixNano: nanos(Date.now() - 4980), name: 'exception', attributes: [attr('exception.type', 'TypeError'), attr('exception.message', 'x is undefined')] }] }),
  ]);
  const traceB = hex(16);
  const protoBody = toProtoShape(tracesJson('billing', [span({ traceId: traceB, name: 'POST /charge', durationMs: 900 })]));
  const res1 = await sendJson(key, '/v1/traces', jsonBody);
  assert.equal(res1.status, 200);
  assert.deepEqual(res1.body, { partialSuccess: {} });
  const res2 = await sendProto(key, 'traces', protoBody, { gzip: true });
  assert.equal(res2.status, 200);
  assert.match(res2.headers['content-type'], /protobuf/);
  const res3 = await sendJson(key, '/v1/traces', tracesJson('checkout-api', [span({ traceId: '00', spanId: 'zz' }), span({ name: 'GET /ok' })]), { gzip: true });
  assert.equal(res3.status, 200, res3.text);
  assert.equal(res3.body.partialSuccess.rejectedSpans, '1', 'a span without valid ids is dropped and reported');
  await drain();

  const services = await owner.client.get('/api/apps/services?range=1h');
  assert.equal(services.status, 200, services.text);
  const names = services.body.items.map((s) => s.name).sort();
  assert.deepEqual(names, ['billing', 'checkout-api']);
  const checkout = services.body.items.find((s) => s.name === 'checkout-api');
  assert.equal(checkout.requests, 2, 'entry spans only: the root plus /ok (the child query span is not counted)');
  assert.ok(checkout.sparkline.length > 5);
  const billing = services.body.items.find((s) => s.name === 'billing');
  assert.ok(billing.p95Ms >= 800 && billing.p95Ms <= 1000);
  assert.equal(billing.status, 'healthy');

  const started = Date.now();
  const search = await owner.client.get('/api/apps/traces?service=checkout-api&range=1h');
  assert.ok(Date.now() - started < 2000);
  assert.equal(search.status, 200, search.text);
  const found = search.body.items.find((t) => t.traceId === traceA);
  assert.ok(found, 'the trace is found by service');
  assert.equal(found.spanCount, 2);
  assert.equal(found.errorCount, 1);
  assert.equal(found.rootName, 'GET /orders');
  assert.ok(found.durationMs >= 100);
  const byAttr = await owner.client.get('/api/apps/traces?attribute=order.id=42&range=1h');
  assert.deepEqual(byAttr.body.items.map((t) => t.traceId), [traceA]);
  const errors = await owner.client.get('/api/apps/traces?status=error&range=1h');
  assert.deepEqual(errors.body.items.map((t) => t.traceId), [traceA]);
  const slow = await owner.client.get('/api/apps/traces?minDurationMs=500&range=1h');
  assert.deepEqual(slow.body.items.map((t) => t.traceId), [traceB]);

  const detail = await owner.client.get(`/api/apps/traces/${traceA}`);
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.body.spans.length, 2);
  const child = detail.body.spans.find((s) => s.name === 'SELECT orders');
  assert.equal(child.parentSpanId, root);
  assert.equal(child.status, 'error');
  assert.equal(child.kind, 'client');
  assert.equal(child.events[0].name, 'exception');
  assert.equal(child.events[0].attributes['exception.type'], 'TypeError');
  assert.ok(child.startOffsetMs >= 0 && child.startOffsetMs < 100);
  assert.equal(detail.body.spans[0].attributes['order.id'], '42');

  const service = await owner.client.get('/api/apps/services/checkout-api?range=1h');
  assert.equal(service.status, 200, service.text);
  assert.ok(service.body.series.length >= 1);
  assert.equal(service.body.errors[0].type, 'TypeError');
  assert.equal(service.body.errors[0].sampleTraceId, traceA);
  assert.ok(service.body.topEndpoints.slowest.some((e) => e.endpoint === 'GET /orders'));
  assert.equal((await owner.client.get('/api/apps/services/nope?range=1h')).status, 404);
});

test('tenants cannot see each other: queries are scoped to the organization', opts, async () => {
  const a = await newOrg('TenantA');
  const b = await newOrg('TenantB');
  const traceId = hex(16);
  await sendJson(a.key, '/v1/traces', tracesJson('secret-svc', [span({ traceId })]));
  await drain();
  assert.equal((await b.owner.client.get(`/api/apps/traces/${traceId}`)).status, 404);
  assert.deepEqual((await b.owner.client.get('/api/apps/services')).body.items, []);
  assert.equal((await a.owner.client.get(`/api/apps/traces/${traceId}`)).status, 200);
});

test('logs: stored, searchable, correlated to traces, and live-tailable', opts, async () => {
  const { owner, key } = await newOrg('Logs');
  const traceId = hex(16);
  const spanId = hex(8);
  await sendJson(key, '/v1/traces', tracesJson('api', [span({ traceId, spanId })]));
  const first = await sendJson(key, '/v1/logs', logsJson('api', [
    logRecord({ body: 'Payment FAILED for order 7', severityNumber: 17, traceId, spanId, attributes: [attr('order.id', '7')] }),
    logRecord({ body: 'cache warmed', severityNumber: 9 }),
    logRecord({ body: 'verbose detail', severityNumber: 5 }),
  ]));
  assert.equal(first.status, 200);
  await drain();
  const all = await owner.client.get('/api/apps/logs?range=1h');
  assert.equal(all.status, 200, all.text);
  assert.equal(all.body.items.length, 3);
  assert.ok(all.body.cursor && all.body.cursor !== '0');
  const text = await owner.client.get('/api/apps/logs?q=payment%20failed&range=1h');
  assert.equal(text.body.items.length, 1, 'case-insensitive text search');
  assert.equal(text.body.items[0].severity, 'error');
  assert.equal(text.body.items[0].traceId, traceId);
  assert.equal((await owner.client.get('/api/apps/logs?severity=warn&range=1h')).body.items.length, 1);
  assert.equal((await owner.client.get('/api/apps/logs?attribute=order.id=7&range=1h')).body.items.length, 1);
  assert.equal((await owner.client.get(`/api/apps/logs?traceId=${traceId}&range=1h`)).body.items.length, 1);
  assert.equal((await owner.client.get('/api/apps/logs?service=other&range=1h')).body.items.length, 0);
  const detail = await owner.client.get(`/api/apps/traces/${traceId}`);
  assert.equal(detail.body.logs.length, 1);
  assert.equal(detail.body.logs[0].body, 'Payment FAILED for order 7');

  // Live tail: only newer records come back, and an idle poll returns the same cursor.
  const tail = await owner.client.get(`/api/apps/logs?after=${all.body.cursor}&range=1h`);
  assert.equal(tail.body.items.length, 0);
  assert.equal(tail.body.cursor, all.body.cursor);
  await sendJson(key, '/v1/logs', logsJson('api', [logRecord({ body: 'late arrival', timeMs: Date.now() - 600000 })]));
  await drain();
  const tail2 = await owner.client.get(`/api/apps/logs?after=${all.body.cursor}&range=1h`);
  assert.deepEqual(tail2.body.items.map((l) => l.body), ['late arrival']);
  assert.notEqual(tail2.body.cursor, all.body.cursor);

  const services = await owner.client.get('/api/apps/services');
  assert.equal(services.body.items.find((s) => s.name === 'api').hasLogs, true);
});

test('redaction removes configured attributes and patterns before anything is stored', opts, async () => {
  const { owner, key } = await newOrg('Redact');
  const put = await owner.client.put('/api/apps/settings').send({
    redaction: {
      rules: [
        { type: 'attribute', key: 'http.request.header.authorization', action: 'drop' },
        { type: 'attribute', key: 'user.id', action: 'hash' },
        { type: 'attribute', key: 'db.*', action: 'drop' },
        { type: 'pattern', preset: 'email', action: 'mask' },
        { type: 'pattern', preset: 'credit_card', action: 'mask' },
      ],
    },
  });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.body.redaction.rules.length, 5);
  assert.ok(put.body.redaction.rules.every((r) => r.id));
  const traceId = hex(16);
  await sendJson(key, '/v1/traces', tracesJson('web', [span({
    traceId,
    attributes: [
      attr('http.request.header.authorization', 'Bearer super-secret-token'),
      attr('user.id', 'u-123'),
      attr('db.statement', 'select * from users'),
      attr('contact', 'jane.doe@example.com wrote'),
      attr('note', 'card 4111 1111 1111 1111 was used'),
      attr('keep.me', 'fine'),
    ],
  })], [attr('db.system', 'postgres')]));
  await sendJson(key, '/v1/logs', logsJson('web', [logRecord({ body: 'sent mail to bob@example.org, ip 10.0.0.1', traceId, spanId: hex(8), attributes: [attr('http.request.header.authorization', 'Bearer abc')] })]));
  await drain();

  const [row] = await select(`SELECT SpanAttributes, ResourceAttributes FROM ${tables.traces} WHERE OrgId = {org:String}`, { org: owner.orgId });
  assert.equal(row.SpanAttributes['http.request.header.authorization'], undefined);
  assert.equal(row.SpanAttributes['db.statement'], undefined);
  assert.equal(row.ResourceAttributes['db.system'], undefined, 'wildcard applies to resource attributes too');
  assert.match(row.SpanAttributes['user.id'], /^sha256:[0-9a-f]{16}$/);
  assert.notEqual(row.SpanAttributes['user.id'], 'u-123');
  assert.equal(row.SpanAttributes.contact, '[REDACTED:email] wrote');
  assert.equal(row.SpanAttributes.note, 'card [REDACTED:credit_card] was used');
  assert.equal(row.SpanAttributes['keep.me'], 'fine');
  const [log] = await select(`SELECT Body, LogAttributes FROM ${tables.logs} WHERE OrgId = {org:String}`, { org: owner.orgId });
  assert.equal(log.Body, 'sent mail to [REDACTED:email], ip 10.0.0.1');
  assert.equal(log.LogAttributes['http.request.header.authorization'], undefined);
  // And it never comes back through the API.
  const detail = await owner.client.get(`/api/apps/traces/${traceId}`);
  assert.ok(!JSON.stringify(detail.body).includes('super-secret-token'));
  assert.ok(!JSON.stringify(detail.body).includes('jane.doe'));
  assert.equal((await owner.client.put('/api/apps/settings').send({ redaction: { rules: [{ type: 'pattern', preset: 'custom', action: 'mask' }] } })).status, 400);
});

test('sampling keeps errors, drops the rest of a ratio-0 trace, and filters logs by severity', opts, async () => {
  const { owner, key } = await newOrg('Sample');
  assert.equal((await owner.client.put('/api/apps/settings').send({ sampling: { tracesRatio: 0, keepErrors: true, logsMinSeverity: 'warn' } })).status, 200);
  const bad = hex(16);
  await sendJson(key, '/v1/traces', tracesJson('s', [span({ name: 'quiet' }), span({ traceId: bad, name: 'broken', error: true })]));
  await sendJson(key, '/v1/logs', logsJson('s', [logRecord({ body: 'info line', severityNumber: 9 }), logRecord({ body: 'warn line', severityNumber: 13 })]));
  await drain();
  const rows = await select(`SELECT TraceId FROM ${tables.traces} WHERE OrgId = {org:String}`, { org: owner.orgId });
  assert.deepEqual(rows.map((r) => r.TraceId), [bad]);
  const logs = await owner.client.get('/api/apps/logs?range=1h');
  assert.deepEqual(logs.body.items.map((l) => l.body), ['warn line']);
  const settings = await owner.client.get('/api/apps/settings');
  assert.equal(settings.body.sampling.tracesRatio, 0);
  assert.equal(settings.body.retention.days, 3, 'free plan keeps 3 days');
  assert.equal(settings.body.retention.plan, 'free');
});

test('over quota answers 429 with Retry-After and mails the owner at 80% and 100%; recovers when limits allow', opts, async () => {
  const { owner, key } = await newOrg('Quota');
  const body = tracesJson('svc', [span()]);
  const size = JSON.stringify(body).length;
  setQuotaOverride(size * 5);
  outbox.length = 0;
  for (let i = 0; i < 4; i++) assert.equal((await sendJson(key, '/v1/traces', body)).status, 200);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(outbox.filter((m) => m.to === owner.email && /80%/.test(m.subject)).length, 1, 'one mail at 80%');
  assert.equal(outbox.filter((m) => /used up/.test(m.subject)).length, 0);
  assert.equal((await sendJson(key, '/v1/traces', body)).status, 200, 'the request that crosses the limit is still accepted');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(outbox.filter((m) => m.to === owner.email && /used up/.test(m.subject)).length, 1, 'one mail at 100%');
  const refused = await sendJson(key, '/v1/traces', body);
  assert.equal(refused.status, 429);
  assert.equal(refused.body.code, 'quota_exceeded');
  assert.ok(Number(refused.headers['retry-after']) > 0);
  assert.equal((await sendJson(key, '/v1/logs', logsJson('svc', [logRecord({ body: 'x' })]))).status, 429, 'logs share the quota');
  const settings = await owner.client.get('/api/apps/settings');
  assert.ok(settings.body.usage.bytes >= size * 5);
  assert.equal(settings.body.usage.limitBytes, size * 5);
  assert.ok(settings.body.usage.percent >= 100);
  setQuotaOverride(null);
  assert.equal((await sendJson(key, '/v1/traces', body)).status, 200, 'a bigger plan lifts it at once');
  assert.equal(outbox.filter((m) => /80%|used up/.test(m.subject)).length, 2, 'mails are sent once per month and level');
});

test('backpressure answers 503 with Retry-After; oversized and malformed bodies are refused', opts, async () => {
  const { key } = await newOrg('Busy');
  const body = tracesJson('svc', [span()]);
  setOtelBackpressure({ maxWaiting: 1 });
  assert.equal((await sendJson(key, '/v1/traces', body)).status, 200);
  assert.equal((await sendJson(key, '/v1/traces', body)).status, 200);
  await new Promise((r) => setTimeout(r, 1100)); // the verdict is cached for a second
  const busy = await sendJson(key, '/v1/traces', body);
  assert.equal(busy.status, 503);
  assert.ok(Number(busy.headers['retry-after']) > 0);
  setOtelBackpressure({ maxWaiting: 2000 });

  assert.equal((await send(key, '/v1/traces', 'not json {', { type: 'json' })).status, 400);
  const garbage = await request(app).post('/v1/traces').set('x-yuktiops-key', key).set('Content-Type', 'application/x-protobuf').send(Buffer.from([0xff, 0xff, 0xff, 0x01, 0x02]));
  assert.equal(garbage.status, 400);
  const wrongType = await request(app).post('/v1/traces').set('x-yuktiops-key', key).set('Content-Type', 'text/plain').send('hello');
  assert.equal(wrongType.status, 415);
  const huge = await request(app).post('/v1/logs').set('x-yuktiops-key', key).set('Content-Type', 'application/json').send(`{"a":"${'x'.repeat(5 * 1024 * 1024)}"}`);
  assert.equal(huge.status, 413);
});

test('metrics are accepted and counted but not stored, with a partial_success note', opts, async () => {
  const { owner, key } = await newOrg('Metrics');
  const metrics = { resourceMetrics: [{ resource: { attributes: [attr('service.name', 'm')] }, scopeMetrics: [{ metrics: [{ name: 'cpu', gauge: { dataPoints: [{ asDouble: 1 }, { asDouble: 2 }] } }] }] }] };
  const res = await sendJson(key, '/v1/metrics', metrics);
  assert.equal(res.status, 200);
  assert.equal(res.body.partialSuccess.rejectedDataPoints, '2');
  assert.match(res.body.partialSuccess.errorMessage, /not stored/);
  const settings = await owner.client.get('/api/apps/settings');
  assert.ok(settings.body.usage.bySignal.metrics > 0);
});

test('connection status reports the first trace per key', opts, async () => {
  const { owner, key, keyId } = await newOrg('Connect');
  const before = await owner.client.get('/api/apps/connection');
  assert.equal(before.status, 200);
  assert.equal(before.body.anyTraceSeen, false);
  assert.equal(before.body.keys[0].lastSeenAt, null);
  assert.equal(before.body.keys[0].id, keyId);
  await sendJson(key, '/v1/logs', logsJson('svc', [logRecord({ body: 'hello' })]));
  const logsOnly = await owner.client.get('/api/apps/connection');
  assert.equal(logsOnly.body.keys[0].lastSignal, 'logs');
  assert.equal(logsOnly.body.keys[0].traceSeen, false);
  await sendJson(key, '/v1/traces', tracesJson('svc', [span()]));
  const after = await owner.client.get('/api/apps/connection');
  assert.equal(after.body.anyTraceSeen, true);
  assert.equal(after.body.keys[0].lastSignal, 'traces');
  assert.ok(Date.now() - Date.parse(after.body.keys[0].lastSeenAt) < 10000);
  assert.ok(after.body.otlpEndpoint.startsWith('http'));
});

test('settings: viewers read, only admins write; telemetry storage trouble is a 503, not a crash', opts, async () => {
  const { owner } = await newOrg('Settings');
  const viewer = await addMember(app, store, owner, { role: 'viewer' });
  const read = await viewer.client.get('/api/apps/settings');
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.redaction.rules, []);
  assert.equal(read.body.sampling.tracesRatio, 1);
  assert.equal(read.body.usage.limitBytes, 1024 ** 3);
  assert.equal((await viewer.client.put('/api/apps/settings').send({ sampling: { tracesRatio: 0.5 } })).status, 403);
  assert.equal((await owner.client.put('/api/apps/settings').send({ sampling: { tracesRatio: 2 } })).status, 400);
  assert.equal((await owner.client.put('/api/apps/settings').send({ sampling: { tracesRatio: 0.25 } })).body.sampling.tracesRatio, 0.25);
  assert.equal((await viewer.client.get('/api/apps/services')).status, 200);
});

// ------------------------------------------------------------------------------------------------ alerts

async function incidents(orgId) {
  return store.client.alertIncident.findMany({ where: { orgId }, include: { rule: true } });
}
/** Spans in every one of the last `minutes` minutes (one entry span per minute, `errors` of `perMinute` failing). */
async function seedMinutes(key, service, { minutes, perMinute = 10, errors = 0, durationMs = 50, endAgoMinutes = 0 }) {
  const spans = [];
  for (let m = 0; m < minutes; m++) {
    const base = Date.now() - (endAgoMinutes + m) * 60000 - 20000;
    for (let i = 0; i < perMinute; i++) spans.push(span({ startMs: base - i * 100, durationMs, error: i < errors }));
  }
  assert.equal((await sendJson(key, '/v1/traces', tracesJson(service, spans))).status, 200);
  await drain();
}

test('alert sources: error rate fires only when the whole window breaches, p95 latency fires, no-traces fires', opts, async () => {
  const { owner, key } = await newOrg('Alerts');
  await store.client.subscription.update({ where: { orgId: owner.orgId }, data: { planId: 'pro' } }); // more alert rules
  const metrics = await owner.client.get('/api/alerts/metrics');
  const keys = metrics.body.items.filter((m) => m.kind === 'app').map((m) => m.key).sort();
  assert.deepEqual(keys, ['app_error_rate', 'app_latency_p95', 'app_no_traces']);
  assert.ok(metrics.body.items.find((m) => m.key === 'app_error_rate').available, 'available once a telemetry key exists');
  const templates = await owner.client.get('/api/alerts/templates');
  assert.ok(templates.body.items.some((t) => t.key === 'app_error_rate' && t.kind === 'app'));

  for (const templateKey of ['app_error_rate', 'app_latency_p95', 'app_no_traces']) {
    const res = await owner.client.post('/api/alerts/rules/from-template').send({ templateKey });
    assert.equal(res.status, 201, res.text);
  }
  // A 4-minute spike does not fire a 5-minute rule.
  await seedMinutes(key, 'checkout', { minutes: 4, perMinute: 10, errors: 10 });
  await seedMinutes(key, 'healthy-svc', { minutes: 7, perMinute: 10, errors: 0, durationMs: 20 });
  await evaluateAlerts(store, owner.orgId, { now: Date.now() });
  assert.deepEqual(await incidents(owner.orgId), [], 'no incident yet: the 5-minute window is not covered by bad minutes');

  // Seven bad minutes (errors and slow) breach the whole 5-minute window.
  await seedMinutes(key, 'checkout', { minutes: 3, perMinute: 10, errors: 10, durationMs: 2500, endAgoMinutes: 4 });
  await seedMinutes(key, 'checkout', { minutes: 4, perMinute: 10, errors: 10, durationMs: 2500, endAgoMinutes: 0 });
  await evaluateAlerts(store, owner.orgId, { now: Date.now() });
  const open = await incidents(owner.orgId);
  const byRule = Object.fromEntries(open.map((i) => [i.rule.metric, i]));
  assert.ok(byRule.app_error_rate, 'error rate incident');
  assert.ok(byRule.app_latency_p95, 'latency incident');
  assert.match(byRule.app_error_rate.name, /on checkout$/);
  assert.equal(open.filter((i) => /healthy-svc/.test(i.name)).length, 0, 'a healthy service stays quiet');
  assert.ok(byRule.app_error_rate.value > 90);
  assert.ok(!byRule.app_no_traces, 'both services are sending');

  // 30 minutes of silence: only the no-traces rule can say anything about a service that stopped.
  await evaluateAlerts(store, owner.orgId, { now: Date.now() + 30 * 60000 });
  const later = await incidents(owner.orgId);
  assert.ok(later.some((i) => i.rule.metric === 'app_no_traces' && /checkout/.test(i.name)), 'no-traces incident');
});

test('alert scope can select services by name', opts, async () => {
  const { owner, key } = await newOrg('Scope');
  const res = await owner.client.post('/api/alerts/rules/from-template').send({
    templateKey: 'app_no_traces',
    scope: { type: 'selected', ids: ['only-this'] },
  });
  assert.equal(res.status, 201, res.text);
  await seedMinutes(key, 'only-this', { minutes: 1 });
  await seedMinutes(key, 'not-this', { minutes: 1 });
  await evaluateAlerts(store, owner.orgId, { now: Date.now() + 30 * 60000 });
  const names = (await incidents(owner.orgId)).map((i) => i.name);
  assert.equal(names.length, 1);
  assert.match(names[0], /only-this/);
  assert.equal(clickhouseDatabase(), DATABASE);
});

test('when ClickHouse is down the dashboard API answers 503 and ingest still accepts (queued for retry)', opts, async () => {
  const { owner, key } = await newOrg('Down');
  configureClickhouse({ url: 'http://127.0.0.1:1' });
  try {
    const res = await owner.client.get('/api/apps/services');
    assert.equal(res.status, 503);
    assert.match(res.body.error, /unavailable/);
    assert.equal((await sendJson(key, '/v1/traces', tracesJson('svc', [span()]))).status, 200, 'ingest does not touch ClickHouse');
  } finally {
    configureClickhouse({ url: undefined });
  }
  await drain();
  assert.equal((await owner.client.get('/api/apps/services')).status, 200);
});
