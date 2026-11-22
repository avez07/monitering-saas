import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import request from 'supertest';
import { setup, closeStore, register } from './helpers.js';
import { enrollServer, bearer, setPlan } from './agent-helpers.js';
import { configureVictoria } from '../src/lib/victoria.js';
import { config } from '../src/config.js';
import { forgetOrgFeatures } from '../src/services/limits.js';
import { decodeWriteRequest, encodeWriteRequest, promForwarder, forgetPromSeenMemo } from '../src/services/prom-remote.js';

// A stand-in VictoriaMetrics: records every request and answers like the Prometheus HTTP API.
const seen = [];
const vm = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    seen.push({ method: req.method, path: req.url.split('?')[0], headers: req.headers, body });
    if (req.url.startsWith('/api/v1/write')) return res.writeHead(204).end();
    const form = new URLSearchParams(body.toString());
    if (form.get('query') === 'broken(')
      return res.writeHead(422, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'error', errorType: 'bad_data', error: 'unexpected end' }));
    const resultType = req.url.startsWith('/api/v1/query_range') ? 'matrix' : 'vector';
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'success', data: { resultType, result: [] } }));
  });
});
let vmUrl;
// remote_write requests go through one long-lived listener. `request(app)` starts a server per request and
// closes it as soon as the response arrives, which can cancel the client's last pending write of a large
// (4 MB) body on Windows: "write ECANCELED".
const api = createServer((req, res) => app(req, res));
before(async () => {
  await new Promise((resolve) => vm.listen(0, '127.0.0.1', resolve));
  vmUrl = `http://127.0.0.1:${vm.address().port}`;
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
});
after(async () => {
  configureVictoria({ url: null });
  api.closeAllConnections();
  await new Promise((resolve) => api.close(resolve));
  await new Promise((resolve) => vm.close(resolve));
  await closeStore();
});

let store, app;
beforeEach(async () => {
  ({ store, app } = await setup());
  seen.length = 0;
  forgetPromSeenMemo();
  configureVictoria({ url: vmUrl });
});

async function proOwner(name = 'Dash') {
  const owner = await register(app, name);
  await setPlan(store, owner, 'pro');
  await forgetOrgFeatures(owner.orgId);
  return owner;
}
const formOf = (entry) => new URLSearchParams(entry.body.toString());
const series = (name, labels = {}) => ({
  labels: [{ name: '__name__', value: name }, ...Object.entries(labels).map(([n, v]) => ({ name: n, value: v }))],
  samples: [{ value: 1.5, timestamp: Date.now() }],
});
const promWrite = (credential, body) =>
  request(api)
    .post('/v1/prom/write')
    .set(bearer(credential))
    .set('Content-Type', 'application/x-protobuf')
    .set('Content-Encoding', 'snappy')
    .set('X-Prometheus-Remote-Write-Version', '0.1.0')
    .send(body);

test('free plans get 402 from every dashboard endpoint; bootstrap exposes plan.features', async () => {
  const owner = await register(app, 'Free');
  for (const path of ['/api/dashboards/presets', '/api/dashboards/presets/node-exporter-full', '/api/dashboards/query?query=up', '/api/dashboards/query_range?query=up', '/api/dashboards/targets']) {
    const res = await owner.client.get(path);
    assert.equal(res.status, 402, `${path}: ${res.text}`);
  }
  assert.deepEqual((await owner.client.get('/api/bootstrap')).body.plan.features, {});
  assert.equal(seen.length, 0, 'nothing reached VictoriaMetrics');

  const pro = await proOwner();
  assert.deepEqual((await pro.client.get('/api/bootstrap')).body.plan.features, { advancedDashboard: true, promMetrics: true });
});

test('presets: list and the node-exporter-full document', async () => {
  const owner = await proOwner();
  const list = await owner.client.get('/api/dashboards/presets');
  assert.equal(list.status, 200);
  assert.ok(list.body.some((p) => p.id === 'node-exporter-full' && p.title));
  const doc = await owner.client.get('/api/dashboards/presets/node-exporter-full');
  assert.equal(doc.status, 200);
  assert.deepEqual(doc.body.variables, ['node', 'container']);
  const panels = doc.body.rows.flatMap((r) => r.panels);
  assert.equal(panels.length, 97);
  const exprs = panels.flatMap((p) => p.targets.map((t) => t.expr)).join('\n');
  assert.ok(!/\$job|\$cadvisor_job|ds_prometheus/.test(exprs));
  assert.ok(/job="cadvisor"[^}]*instance="\$node"/.test(exprs));
  assert.equal((await owner.client.get('/api/dashboards/presets/nope')).status, 404);
});

test('queries always carry extra_label=yk_org=<orgId>; step floor and point cap apply', async () => {
  const owner = await proOwner();
  const now = Math.floor(Date.now() / 1000);
  const res = await owner.client
    .get('/api/dashboards/query_range')
    .query({ query: 'up{yk_org="someone-else"}', start: now - 3600, end: now, step: '1', extra_label: 'yk_org=evil' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.data.resultType, 'matrix');
  const form = formOf(seen.at(-1));
  assert.equal(seen.at(-1).path, '/api/v1/query_range');
  assert.deepEqual(form.getAll('extra_label'), [`yk_org=${owner.orgId}`]);
  assert.equal(form.get('step'), '15s');
  assert.equal(form.get('query'), 'up{yk_org="someone-else"}');

  // 30 days at 15 s would be 172 800 points: the step is widened to stay under 11 000.
  await owner.client.get('/api/dashboards/query_range').query({ query: 'up', start: now - 30 * 86400, end: now, step: '15s' });
  assert.ok(parseFloat(formOf(seen.at(-1)).get('step')) >= (30 * 86400) / 11000);

  const instant = await owner.client.get('/api/dashboards/query').query({ query: 'up', time: now });
  assert.equal(instant.status, 200);
  assert.deepEqual(formOf(seen.at(-1)).getAll('extra_label'), [`yk_org=${owner.orgId}`]);

  const bad = await owner.client.get('/api/dashboards/query').query({ query: 'broken(' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'bad_query');
  assert.equal((await owner.client.get('/api/dashboards/query_range').query({ query: 'up', start: now, end: now - 10 })).status, 400);

  configureVictoria({ url: 'http://127.0.0.1:1' });
  const down = await owner.client.get('/api/dashboards/query').query({ query: 'up' });
  assert.equal(down.status, 503);
  assert.equal(down.body.code, 'metrics_unavailable');
});

test('prom write: agent yk_* labels are replaced by the real org and agent; targets report data', async () => {
  const owner = await proOwner();
  const server = await enrollServer(app, owner, 1);
  const body = encodeWriteRequest({
    timeseries: [
      series('node_load1', { instance: server.agentId, job: 'node', yk_org: 'evil-org', yk_agent: 'spoofed', yk_extra: 'x' }),
      series('node_load5', { instance: server.agentId, job: 'node' }),
      { labels: [{ name: 'job', value: 'no-name' }], samples: [{ value: 1, timestamp: Date.now() }] },
    ],
  });
  const res = await promWrite(server.credential, body);
  assert.equal(res.status, 202, res.text);
  await promForwarder.idle();
  const write = seen.find((s) => s.path === '/api/v1/write');
  assert.ok(write, 'the batch was forwarded');
  assert.equal(write.headers['content-encoding'], 'snappy');
  const forwarded = decodeWriteRequest(write.body);
  assert.equal(forwarded.timeseries.length, 2, 'the series without a name was dropped');
  for (const ts of forwarded.timeseries) {
    const labels = Object.fromEntries(ts.labels.map((l) => [l.name, l.value]));
    assert.equal(labels.yk_org, owner.orgId);
    assert.equal(labels.yk_agent, server.agentId);
    assert.equal(labels.yk_extra, undefined);
    assert.equal(ts.labels.filter((l) => l.name === 'yk_org').length, 1);
  }
  const targets = await owner.client.get('/api/dashboards/targets');
  assert.equal(targets.status, 200);
  assert.deepEqual(
    targets.body.map((t) => [t.agentId, t.hasData]),
    [[server.agentId, true]],
  );
});

test('prom write: 401, 402 for free plans, 400 bad body, 413 large body, 429 series cap', async () => {
  assert.equal((await promWrite('agent_nope', encodeWriteRequest({ timeseries: [] }))).status, 401);

  const free = await register(app, 'FreeAgent');
  const freeServer = await enrollServer(app, free, 1);
  const denied = await promWrite(freeServer.credential, encodeWriteRequest({ timeseries: [series('up')] }));
  assert.equal(denied.status, 402);

  const owner = await proOwner('Caps');
  const server = await enrollServer(app, owner, 2);
  assert.equal((await promWrite(server.credential, Buffer.from('not snappy at all'))).status, 400);
  assert.equal((await promWrite(server.credential, Buffer.alloc(4 * 1024 * 1024 + 10, 1))).status, 413);

  const cap = config.PROM_MAX_SERIES_PER_ORG;
  config.PROM_MAX_SERIES_PER_ORG = 3;
  try {
    const many = encodeWriteRequest({ timeseries: Array.from({ length: 6 }, (_, i) => series('node_cpu_seconds_total', { cpu: String(i) })) });
    const limited = await promWrite(server.credential, many);
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, 'series_limit');
    assert.ok(limited.headers['retry-after']);
  } finally {
    config.PROM_MAX_SERIES_PER_ORG = cap;
  }
  await promForwarder.idle();
});
