import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCurl } from '../src/lib/curl.js';

test('simple GET', () => {
  const r = parseCurl('curl https://example.com/health');
  assert.equal(r.method, 'GET');
  assert.equal(r.url, 'https://example.com/health');
});

test('POST with headers and body over continuations', () => {
  const r = parseCurl(`curl -X POST 'https://api.example.com/v1/items?limit=5&q=a%20b' \\
  -H 'Content-Type: application/json' \\
  -H "Authorization: Bearer abc" \\
  --data-raw '{"a":1}' --compressed`);
  assert.equal(r.method, 'POST');
  assert.equal(r.headers['Content-Type'], 'application/json');
  assert.equal(r.headers.Authorization, 'Bearer abc');
  assert.equal(r.body, '{"a":1}');
  assert.deepEqual(r.query, { limit: '5', q: 'a b' });
});

test('data implies POST, --json adds headers', () => {
  assert.equal(parseCurl('curl -d x=1 http://a.test').method, 'POST');
  const r = parseCurl(`curl --json '{"x":1}' http://a.test`);
  assert.equal(r.method, 'POST');
  assert.equal(r.headers['Content-Type'], 'application/json');
});

test('-u becomes basic auth, --url works, -G moves data to the query', () => {
  const r = parseCurl('curl -u user:pass --url "http://a.test/x" -G -d a=1 -d b=2');
  assert.equal(r.headers.Authorization, `Basic ${Buffer.from('user:pass').toString('base64')}`);
  assert.equal(r.method, 'GET');
  assert.equal(r.url, 'http://a.test/x?a=1&b=2');
  assert.equal(r.body, null);
});

test('cmd and PowerShell continuations, explicit method wins', () => {
  const r = parseCurl('curl -X PUT ^\r\n "http://a.test/p" ^\r\n -H "X-A: 1"');
  assert.equal(r.method, 'PUT');
  assert.equal(r.headers['X-A'], '1');
  assert.equal(parseCurl('curl `\n -I http://a.test').method, 'HEAD');
});

test('errors', () => {
  assert.equal(parseCurl('').ok, false);
  assert.equal(parseCurl('wget http://a.test').ok, false);
  assert.equal(parseCurl('curl -X POST').ok, false);
});
