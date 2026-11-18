import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { HttpError, classifyError, errorHandler, redact } from '../src/lib/errors.js';
import { serviceHealth } from '../src/services/service-health.js';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const prismaError = (code, message = 'x') => Object.assign(new Error(message), { code, name: 'PrismaClientKnownRequestError' });

test('classifyError maps each failure type to its own status and code', () => {
  const cases = [
    [prismaError('P1001', "Can't reach database server at db:5432"), 503, 'database_unreachable'],
    [prismaError('P2024'), 504, 'database_timeout'],
    [prismaError('P2021'), 503, 'database_out_of_date'],
    [new Error('password authentication failed for user "x"'), 503, 'database_auth_failed'],
    [Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), { name: 'MaxRetriesPerRequestError' }), 503, 'redis_unreachable'],
    [Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:8080'), { code: 'ECONNREFUSED' }), 502, 'upstream_refused'],
    [Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }), 504, 'upstream_timeout'],
    [Object.assign(new Error('aborted'), { name: 'AbortError' }), 504, 'upstream_timeout'],
    [Object.assign(new Error('getaddrinfo ENOTFOUND x.test'), { code: 'ENOTFOUND' }), 502, 'upstream_dns_failed'],
    [Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), 502, 'upstream_tls_failed'],
    [new HttpError(401, 'Invalid API key.', { code: 'invalid_api_key' }), 401, 'invalid_api_key'],
    [new HttpError(404, 'Service not found.'), 404, 'not_found'],
    [new TypeError("Cannot read properties of undefined (reading 'x')"), 500, 'internal_error'],
  ];
  for (const [error, status, code] of cases) {
    const got = classifyError(error);
    assert.equal(got.code, code, error.message);
    assert.equal(got.status, status, error.message);
  }
});

test('validation errors are 400 validation_failed', () => {
  const err = z.object({ a: z.string() }).safeParse({}).error;
  const got = classifyError(err);
  assert.equal(got.status, 400);
  assert.equal(got.code, 'validation_failed');
});

test('only real bugs are 500, and they carry an error id but no stack', () => {
  const logs = [];
  const original = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  try {
    const res = fakeRes();
    errorHandler(new TypeError('boom'), { method: 'GET', path: '/services' }, res, () => {});
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.code, 'internal_error');
    assert.ok(res.body.errorId && res.body.timestamp && res.body.hint);
    assert.ok(!JSON.stringify(res.body).includes('at '), 'no stack in the response');
    assert.ok(logs.join('\n').includes('TypeError: boom'), 'the full error is logged');
    assert.ok(logs.join('\n').includes(res.body.errorId));
  } finally {
    console.error = original;
  }
});

test('infrastructure failures use 5xx codes other than 500 and keep the legacy error field', () => {
  const original = console.error;
  console.error = () => {};
  try {
    const res = fakeRes();
    errorHandler(prismaError('P1001', "Can't reach database server"), { method: 'GET', path: '/x' }, res, () => {});
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.service, 'database');
    assert.equal(res.body.error, res.body.message);
    assert.equal(res.headers['Retry-After'], '5');
    assert.match(res.body.hint, /DATABASE_URL/);
  } finally {
    console.error = original;
  }
});

test('secrets never reach the response or the log', () => {
  const secret = 'yk_live_abcdefghijklmnop1234';
  const logs = [];
  const original = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  try {
    const res = fakeRes();
    const error = new Error(`failed connecting postgres://app:hunter2pass@db:5432/x with Bearer abcdefghijkl1234 and ${secret} password=letmein99`);
    error.code = 'P1001';
    errorHandler(error, { method: 'POST', path: '/x' }, res, () => {});
    const everything = JSON.stringify(res.body) + logs.join('\n');
    for (const leak of [secret, 'hunter2pass', 'abcdefghijkl1234', 'letmein99']) assert.ok(!everything.includes(leak), leak);
  } finally {
    console.error = original;
  }
  assert.equal(redact('token=abc123456789'), 'token=[redacted]');
});

test('serviceHealth: running service is healthy', () => {
  const row = { name: 'nginx', state: 'running', detail: '', stateChangedAt: new Date(NOW) };
  assert.equal(serviceHealth(row, { lastSeen: new Date(NOW - 1000) }, NOW), null);
});

test('serviceHealth: agent offline wins over stale service state', () => {
  const row = { name: 'nginx', state: 'running', detail: '', stateChangedAt: new Date(NOW) };
  const h = serviceHealth(row, { lastSeen: new Date(NOW - 20 * 60000) }, NOW);
  assert.equal(h.code, 'agent_offline');
  assert.match(h.cause, /20 min/);
  assert.ok(h.hint && h.since);
});

test('serviceHealth: failed, stopped, refused, timeout, dns, unhealthy, unknown', () => {
  const server = { lastSeen: new Date(NOW) };
  const at = (state, detail) => serviceHealth({ name: 'svc', state, detail, stateChangedAt: new Date(NOW - 60000) }, server, NOW);
  assert.equal(at('failed', 'failed (failed)').code, 'service_failed');
  assert.equal(at('stopped', 'inactive (dead)').code, 'process_not_found');
  assert.equal(at('stopped', '').code, 'service_stopped');
  assert.equal(at('stopped', 'connection refused').code, 'connection_refused');
  assert.equal(at('stopped', 'timed out').code, 'connection_timeout');
  assert.equal(at('stopped', 'DNS lookup failed').code, 'dns_failed');
  assert.equal(at('stopped', 'unexpected reply').code, 'unhealthy_response');
  assert.equal(at('unknown', '').code, 'unknown_state');
  const h = at('failed', 'failed (failed)');
  assert.equal(h.severity, 'critical');
  assert.ok(h.since && h.hint && h.timestamp && h.service === 'svc');
});

function fakeRes() {
  return {
    headersSent: false,
    headers: {},
    set(k, v) { this.headers[k] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}
