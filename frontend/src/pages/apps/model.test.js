import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LANGUAGES,
  collectorConfig,
  connectionHints,
  customiseExamples,
  envExports,
  envVars,
  installSteps,
  listQuery,
  parseAttribute,
  percentToRatio,
  waterfallRows,
} from './model.js';

test('envVars: the four standard variables with key and endpoint', () => {
  const out = envVars({ service: 'checkout api', endpoint: 'https://otlp.example.com/', key: 'yk_otel_abc' });
  assert.match(out, /^OTEL_SERVICE_NAME=checkout-api$/m);
  assert.match(out, /^OTEL_EXPORTER_OTLP_ENDPOINT=https:\/\/otlp\.example\.com$/m);
  assert.match(out, /^OTEL_EXPORTER_OTLP_HEADERS=x-yuktiops-key=yk_otel_abc$/m);
  assert.match(out, /^OTEL_RESOURCE_ATTRIBUTES=deployment\.environment=production$/m);
});

test('envVars: placeholders when nothing is given, exports are quoted', () => {
  assert.match(envVars(), /OTEL_SERVICE_NAME=my-app/);
  assert.match(envVars(), /yk_otel_PASTE_YOUR_KEY/);
  assert.match(envExports({ key: 'k' }), /^export OTEL_EXPORTER_OTLP_HEADERS="x-yuktiops-key=k"$/m);
});

test('installSteps: zero-code commands per language', () => {
  assert.match(installSteps('node').run, /auto-instrumentations-node\/register/);
  assert.match(installSteps('python').install, /opentelemetry-bootstrap/);
  assert.match(installSteps('python').run, /^opentelemetry-instrument/);
  assert.match(installSteps('java').run, /-javaagent:/);
  assert.equal(installSteps('collector'), null);
});

test('every language has all six customise examples', () => {
  for (const { id } of LANGUAGES.filter((l) => l.id !== 'collector'))
    assert.equal(customiseExamples(id).length, 6, id);
  assert.deepEqual(customiseExamples('collector'), []);
  assert.match(customiseExamples('node').find((e) => e.id === 'sampling').code, /parentbased_traceidratio/);
});

test('collectorConfig: otlphttp exporter with header and filelog receiver', () => {
  const out = collectorConfig({ key: 'yk_otel_x', logPath: '/srv/app.log' });
  assert.match(out, /otlphttp:/);
  assert.match(out, /x-yuktiops-key: yk_otel_x/);
  assert.match(out, /filelog:/);
  assert.match(out, /include: \[ \/srv\/app\.log \]/);
});

test('connectionHints covers each state', () => {
  assert.equal(connectionHints({ keys: [] }).state, 'no-key');
  assert.equal(connectionHints({ keys: [{ lastSeenAt: null }] }).state, 'waiting');
  assert.ok(connectionHints({ keys: [{ lastSeenAt: null }] }).hints.length >= 4);
  assert.equal(connectionHints({ keys: [{ lastSeenAt: 'x' }] }).state, 'logs-only');
  assert.equal(connectionHints({ anyTraceSeen: true, keys: [{}] }).state, 'connected');
});

test('parseAttribute and listQuery', () => {
  assert.deepEqual(parseAttribute(' order.id = 42 '), { key: 'order.id', value: '42' });
  assert.equal(parseAttribute('nokey'), null);
  assert.equal(parseAttribute('=x'), null);
  assert.equal(parseAttribute('a='), null);
  const q = new URLSearchParams(
    listQuery({ service: 'api', status: '', minDurationMs: '250', attributes: [{ key: 'a', value: 'b' }] }),
  );
  assert.equal(q.get('service'), 'api');
  assert.equal(q.get('minDurationMs'), '250');
  assert.equal(q.has('status'), false);
  assert.deepEqual(q.getAll('attribute'), ['a=b']);
});

test('waterfallRows nests children and keeps tiny spans visible', () => {
  const rows = waterfallRows({
    durationMs: 100,
    spans: [
      { spanId: 'b', parentSpanId: 'a', startOffsetMs: 10, durationMs: 0.01 },
      { spanId: 'a', parentSpanId: null, startOffsetMs: 0, durationMs: 100 },
    ],
  });
  assert.deepEqual(rows.map((r) => [r.span.spanId, r.depth]), [['a', 0], ['b', 1]]);
  assert.equal(rows[0].width, 100);
  assert.equal(rows[1].left, 10);
  assert.equal(rows[1].width, 0.5);
});

test('percentToRatio clamps', () => {
  assert.equal(percentToRatio('10'), 0.1);
  assert.equal(percentToRatio('250'), 1);
  assert.equal(percentToRatio('-1'), 0);
  assert.equal(percentToRatio('abc'), null);
});
