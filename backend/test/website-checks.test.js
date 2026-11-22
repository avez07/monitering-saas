import test from 'node:test';
import assert from 'node:assert/strict';

test('API checks with a JSON body default to Content-Type: application/json', async () => {
  const { requestHeaders } = await import('../src/services/checks.js');
  assert.equal(requestHeaders({ body: '{"a":1}', headers: { 'X-client': 'true' } })['content-type'], 'application/json');
  assert.equal(requestHeaders({ body: '{"a":1}', headers: { 'Content-Type': 'text/plain' } })['content-type'], undefined);
  assert.equal(requestHeaders({ body: 'a=1', headers: {} })['content-type'], undefined);
  assert.equal(requestHeaders({ body: null, headers: {} })['content-type'], undefined);
});

test('an API body with // comments is refused at save time, clean JSON is accepted', async () => {
  const { assertJsonBody } = await import('../src/routes/websites.js');
  assert.throws(() => assertJsonBody('{\n // "email": "a",\n "email": "b"\n}', {}), (e) => e.status === 400 && e.code === 'invalid_json_body');
  assert.throws(() => assertJsonBody('not json', { 'Content-Type': 'application/json' }), /not valid JSON/);
  assert.doesNotThrow(() => assertJsonBody('{"email":"b"}', {}));
  assert.doesNotThrow(() => assertJsonBody('a=1&b=2', {}));
  assert.doesNotThrow(() => assertJsonBody(null, {}));
});

test('a failed check keeps what the site answered, redacted, for the log', async () => {
  const { runCheck } = await import('../src/services/checks.js');
  const request = async () => ({
    status: 429,
    headers: { 'retry-after': '30' },
    body: '{"message":"Too many requests","token":"abc12345678secret"}\n  try later',
    latencyMs: 5,
  });
  const failed = await runCheck({ type: 'api', method: 'POST', target: 'https://x.test', headers: {}, body: null }, { request });
  assert.equal(failed.error, 'status_429');
  assert.match(failed.detail, /^HTTP 429 · Retry-After: 30 · /);
  assert.match(failed.detail, /Too many requests/);
  assert.ok(!failed.detail.includes('abc12345678secret'));
  const passed = await runCheck({ type: 'api', method: 'GET', target: 'https://x.test', headers: {} }, { request: async () => ({ status: 200, headers: {}, body: 'ok' }) });
  assert.equal(passed.detail, null);
});
