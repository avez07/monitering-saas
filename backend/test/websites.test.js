import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { allowLoopbackForTests } from '../src/services/uptime.js';
import { runDueChecks, runCheck, recordCheckResult, daysLeft, warningBand } from '../src/services/checks.js';
import { evaluateAlerts, deliverNotifications } from '../src/services/workers.js';
import {
  registrableDomain,
  parseRdapExpiry,
  rdapServerFor,
  lookupDomainExpiry,
  refreshDomainExpiry,
  resetRdapCache,
} from '../src/services/rdap.js';
import { setup, closeStore, register, addMember } from './helpers.js';
import { captureTransports, resetTransports, fakeServer } from './b2-helpers.js';

let store, app, limits, sent, site, mode;
beforeEach(async () => {
  ({ store, app, limits } = await setup());
  sent = captureTransports();
  allowLoopbackForTests(true);
  mode = 'up';
  site = await fakeServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/ok') return setTimeout(() => res.end('Hello World'), Number(url.searchParams.get('delay') || 0));
    if (url.pathname === '/flaky') {
      res.statusCode = mode === 'down' ? 500 : 200;
      return res.end('flaky');
    }
    if (url.pathname === '/shop') return res.end('<html>Welcome. Add to cart</html>');
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: '/shop' });
      return res.end();
    }
    if (url.pathname === '/api') {
      if (req.headers['x-key'] !== 'k1') {
        res.statusCode = 401;
        return res.end('{"error":"nope"}');
      }
      res.setHeader('content-type', 'application/json');
      return res.end('{"status":"ok","version":2}');
    }
    res.statusCode = 404;
    res.end('not found');
  });
});
afterEach(async () => {
  allowLoopbackForTests(false);
  resetTransports();
  await site.close();
});
after(closeStore);

const upgrade = async (owner, planId = 'pro') => {
  const sub = await store.find('subscription', { orgId: owner.orgId });
  await store.update('subscription', sub.id, { planId });
};
const create = (owner, body) => owner.client.post('/api/websites').send({ intervalSeconds: 60, ...body });
const monitorRow = (id) => store.find('uptimeMonitor', { id });

test('plan limits, validation and roles on website creation', async () => {
  const owner = await register(app, 'Sites');
  const fast = await create(owner, { name: 'Fast', type: 'http', url: 'https://1.1.1.1' });
  assert.equal(fast.status, 402, 'free plan checks every 5 minutes at most');
  const bad = await create(owner, { name: 'Private', type: 'http', url: 'http://10.0.0.1/', intervalSeconds: 300 });
  assert.equal(bad.status, 400);
  allowLoopbackForTests(false);
  assert.equal((await create(owner, { name: 'Loop', type: 'http', url: site.url('/ok'), intervalSeconds: 300 })).status, 400);
  assert.equal((await create(owner, { name: 'NoKw', type: 'keyword', url: 'https://1.1.1.1', intervalSeconds: 300 })).status, 400);
  assert.equal((await create(owner, { name: 'NoPort', type: 'tcp', host: '1.1.1.1', intervalSeconds: 300 })).status, 400);
  assert.equal(
    (await create(owner, { name: 'Hdr', type: 'api', url: 'https://1.1.1.1', intervalSeconds: 300, headers: { 'Host': 'x' } })).status,
    400,
  );
  for (let i = 0; i < 5; i++) {
    const ok = await create(owner, { name: `Site ${i}`, type: 'http', url: 'https://1.1.1.1', intervalSeconds: 300 });
    assert.equal(ok.status, 201, ok.text);
  }
  const sixth = await create(owner, { name: 'Six', type: 'http', url: 'https://1.1.1.1', intervalSeconds: 300 });
  assert.equal(sixth.status, 402);
  const list = (await owner.client.get('/api/websites')).body;
  assert.deepEqual(list.limits, { used: 5, max: 5, minIntervalSeconds: 300 });
  assert.equal(list.items[0].status, 'pending');
  const viewer = await addMember(app, store, owner, { role: 'viewer' });
  assert.equal((await viewer.client.get('/api/websites')).status, 200);
  assert.equal((await create(viewer, { name: 'Nope', type: 'http', url: 'https://1.1.1.1', intervalSeconds: 300 })).status, 403);
  // An ended subscription cannot add anything.
  const sub = await store.find('subscription', { orgId: owner.orgId });
  await store.update('subscription', sub.id, { status: 'cancelled' });
  assert.equal((await create(owner, { name: 'Late', type: 'http', url: 'https://1.1.1.1', intervalSeconds: 300 })).status, 402);
});

test('http, keyword, api and tcp checks work against a local server', async () => {
  const owner = await register(app, 'Types');
  await upgrade(owner);
  const make = async (body) => {
    const res = await create(owner, body);
    assert.equal(res.status, 201, res.text);
    return res.body;
  };
  const run = async (website) => {
    limits.windows.clear(); // the real route allows 10 manual checks a minute
    return (await owner.client.post(`/api/websites/${website.id}/check`)).body;
  };

  const page = await make({ name: 'Page', type: 'http', url: site.url('/ok') });
  assert.equal(page.status, 'pending');
  assert.equal(page.host, '127.0.0.1');
  assert.equal((await run(page)).ok, true);
  assert.equal((await run(await make({ name: 'Missing', type: 'http', url: site.url('/nope') }))).error, 'status_404');
  // Plain http checks accept 3xx without following it.
  assert.equal((await run(await make({ name: 'Redir', type: 'http', url: site.url('/redirect') }))).ok, true);

  const present = await make({ name: 'KwPresent', type: 'keyword', url: site.url('/shop'), keyword: 'add to CART' });
  assert.equal((await run(present)).ok, true, 'keyword match ignores case');
  const missing = await make({ name: 'KwMissing', type: 'keyword', url: site.url('/shop'), keyword: 'Out of stock' });
  assert.equal((await run(missing)).error, 'keyword_missing');
  const absent = await make({ name: 'KwAbsent', type: 'keyword', url: site.url('/shop'), keyword: 'Add to cart', keywordMode: 'absent' });
  assert.equal((await run(absent)).error, 'keyword_found');
  // Keyword and api checks follow redirects (each hop is vetted again).
  assert.equal((await run(await make({ name: 'KwRedir', type: 'keyword', url: site.url('/redirect'), keyword: 'Welcome' }))).ok, true);

  const api = await make({
    name: 'API', type: 'api', url: site.url('/api'), method: 'POST', body: '{"ping":1}',
    headers: { 'X-Key': 'k1' }, expectedStatus: 200, jsonContains: '"status":"ok"',
  });
  assert.deepEqual(api.headers, { 'X-Key': '••••' }, 'header values are masked');
  assert.equal((await run(api)).ok, true);
  const seen = site.hits.findLast((h) => h.url === '/api');
  assert.equal(seen.method, 'POST');
  assert.equal(seen.headers['x-key'], 'k1');
  const wrongJson = await make({ name: 'API2', type: 'api', url: site.url('/api'), headers: { 'X-Key': 'k1' }, jsonContains: '"status":"fail"' });
  assert.equal((await run(wrongJson)).error, 'json_missing');
  const noKey = await make({ name: 'API3', type: 'api', url: site.url('/api'), expectedStatus: 401 });
  assert.equal((await run(noKey)).ok, true, 'an expected 401 counts as healthy');
  const wrongStatus = await make({ name: 'API4', type: 'api', url: site.url('/api') });
  assert.equal((await run(wrongStatus)).error, 'status_401');
  // Keeping a masked header value on edit keeps the stored value.
  const edit = await owner.client.patch(`/api/websites/${api.id}`).send({ headers: { 'X-Key': '••••' }, name: 'API renamed' });
  assert.equal(edit.status, 200, edit.text);
  assert.equal((await monitorRow(api.id)).headers['X-Key'], 'k1');

  const tcp = await make({ name: 'Port', type: 'tcp', host: '127.0.0.1', port: site.port });
  assert.equal(tcp.target, `tcp://127.0.0.1:${site.port}`);
  assert.equal((await run(tcp)).ok, true);
  const closed = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
  const dead = await make({ name: 'Closed', type: 'tcp', host: '127.0.0.1', port: closed });
  assert.equal((await run(dead)).error, 'connection_refused');

  const detail = (await owner.client.get(`/api/websites/${page.id}`)).body;
  assert.equal(detail.status, 'up');
  assert.equal(detail.uptime['24h'], 100);
});

test('retry before down: one failure is not an outage, two are; the site alerts and recovers', async () => {
  const owner = await register(app, 'Retry');
  await upgrade(owner);
  const web = (await create(owner, { name: 'Flaky', type: 'http', url: site.url('/flaky') })).body;
  const t0 = Date.now();
  assert.equal(await runDueChecks(store, { now: t0 }), 1);
  assert.equal((await monitorRow(web.id)).status, 'healthy');
  mode = 'down';
  const t1 = t0 + 60000;
  await runDueChecks(store, { now: t1 });
  let row = await monitorRow(web.id);
  assert.equal(row.status, 'healthy', 'a single failure keeps the site up');
  assert.equal(row.consecutiveFailures, 1);
  assert.equal(new Date(row.nextCheckAt).getTime(), t1 + 30000, 'retry comes sooner than the interval');
  let shown = (await owner.client.get('/api/websites')).body.items[0];
  assert.equal(shown.retrying, true);
  assert.equal(await runDueChecks(store, { now: t1 + 10000 }), 0, 'not due yet');
  await evaluateAlerts(store, owner.orgId, { now: t1 + 10000 });
  assert.equal((await store.list('alertIncident', { orgId: owner.orgId })).length, 0);

  await runDueChecks(store, { now: t1 + 30000 });
  row = await monitorRow(web.id);
  assert.equal(row.status, 'unhealthy');
  assert.equal(row.lastError, 'status_500');
  // Down within 2 intervals of the first failure: first failure at t1, alert at t1 + 30s (< 120s).
  await evaluateAlerts(store, owner.orgId, { now: t1 + 30000 });
  const [incident] = await store.list('alertIncident', { orgId: owner.orgId });
  assert.equal(incident.name, 'Website is down on Flaky');
  assert.equal(incident.state, 'firing');
  await deliverNotifications(store, owner.orgId, { now: t1 + 30000 });
  assert.match(sent.email[0].subject, /^\[CRITICAL\] Website is down on Flaky/);
  assert.match(sent.email[0].text, /status_500/);

  mode = 'up';
  await runDueChecks(store, { now: t1 + 90000 });
  assert.equal((await monitorRow(web.id)).status, 'healthy');
  await evaluateAlerts(store, owner.orgId, { now: t1 + 90000 });
  await evaluateAlerts(store, owner.orgId, { now: t1 + 160000 });
  assert.equal((await store.find('alertIncident', { id: incident.id })).state, 'resolved');
  await deliverNotifications(store, owner.orgId, { now: t1 + 160000 });
  assert.match(sent.email[1].subject, /^\[Recovered\]/);
  shown = (await owner.client.get('/api/websites')).body.items[0];
  assert.equal(shown.status, 'up');
});

test('200 monitors finish within their interval and a down site alerts within two intervals', async () => {
  const owner = await register(app, 'Scale');
  await upgrade(owner, 'business');
  const rows = Array.from({ length: 200 }, (_, i) => ({
    orgId: owner.orgId, projectId: owner.project.id, name: `m-${i}`, target: site.url(`/ok?i=${i}&delay=15`),
    intervalSeconds: 60, failureThreshold: 2, status: 'pending',
  }));
  await store.client.uptimeMonitor.createMany({ data: rows });
  const started = Date.now();
  const ran = await runDueChecks(store, { now: started });
  const elapsed = Date.now() - started;
  assert.equal(ran, 200);
  assert.ok(elapsed < 30000, `200 checks took ${elapsed}ms (interval is 60s)`);
  const healthy = await store.client.uptimeMonitor.count({ where: { orgId: owner.orgId, status: 'healthy' } });
  assert.equal(healthy, 200);
  assert.equal(await store.client.uptimeCheck.count({ where: { orgId: owner.orgId } }), 200);
  // Politeness: never more than 2 at once against one host.
  let active = 0;
  let peak = 0;
  const probe = await fakeServer((req, res) => {
    active++;
    peak = Math.max(peak, active);
    setTimeout(() => {
      active--;
      res.end('ok');
    }, 20);
  });
  try {
    await store.client.uptimeMonitor.updateMany({ data: { target: probe.url('/x'), nextCheckAt: null } });
    await runDueChecks(store, { now: Date.now(), concurrency: 50, perHost: 2 });
    assert.ok(peak <= 2, `peak concurrent per host was ${peak}`);
  } finally {
    await probe.close();
  }
});

test('paused websites are skipped; deleting removes the website but keeps incident history', async () => {
  const owner = await register(app, 'Pause');
  await upgrade(owner);
  const web = (await create(owner, { name: 'Pausable', type: 'http', url: site.url('/ok') })).body;
  const paused = await owner.client.post(`/api/websites/${web.id}/pause`);
  assert.equal(paused.body.status, 'paused');
  assert.equal(await runDueChecks(store, { now: Date.now() + 1000 }), 0);
  assert.equal((await owner.client.post(`/api/websites/${web.id}/resume`)).body.status, 'pending');
  assert.equal(await runDueChecks(store, { now: Date.now() + 1000 }), 1);
  const resource = await store.find('monitoredResource', { orgId: owner.orgId, externalId: web.id });
  assert.ok(resource);
  assert.equal((await owner.client.delete(`/api/websites/${web.id}`)).status, 204);
  assert.equal(await monitorRow(web.id), null);
  assert.ok((await store.find('monitoredResource', { id: resource.id })).deletedAt);
  assert.equal((await owner.client.get(`/api/websites/${web.id}`)).status, 404);
});

test('check history reports uptime percent, latency buckets and recent checks', async () => {
  const owner = await register(app, 'History');
  await upgrade(owner);
  const web = (await create(owner, { name: 'Hist', type: 'http', url: site.url('/ok') })).body;
  const now = Date.now();
  const data = Array.from({ length: 10 }, (_, i) => ({
    orgId: owner.orgId, monitorId: web.id, ok: i >= 2, statusCode: i >= 2 ? 200 : 503, latencyMs: 100 + i * 10,
    error: i >= 2 ? null : 'status_503', createdAt: new Date(now - (i + 1) * 120000),
  }));
  await store.client.uptimeCheck.createMany({ data });
  const day = (await owner.client.get(`/api/websites/${web.id}/checks?range=24h`)).body;
  assert.equal(day.range, '24h');
  assert.equal(day.checks, 10);
  assert.equal(day.uptimePercent, 80);
  assert.ok(day.points.length >= 1 && day.points.length <= 10);
  assert.equal(day.recent.length, 10);
  assert.ok(day.avgLatencyMs >= 100 && day.avgLatencyMs <= 200);
  assert.equal((await owner.client.get(`/api/websites/${web.id}/checks?range=1h`)).status, 200);
  assert.equal((await owner.client.get(`/api/websites/${web.id}/checks?range=99d`)).status, 400);
  assert.equal((await owner.client.get('/api/websites')).body.items[0].uptime24h, 80);
});

test('SSL certificate expiry: parsing, warning bands, API and alert', async () => {
  const now = Date.parse('2026-11-15T00:00:00Z');
  assert.equal(daysLeft('2026-12-15T00:00:00Z', now), 30);
  assert.equal(daysLeft('2026-11-14T00:00:00Z', now), -1);
  assert.equal(daysLeft(null, now), null);
  assert.deepEqual([60, 30, 20, 14, 10, 7, 3, 0, -1].map(warningBand), [null, 30, 30, 14, 14, 7, 7, 7, 0]);
  // The check reads the expiry the TLS layer reports (here from a stubbed request).
  const monitor = { type: 'http', target: 'https://shop.example.com/', timeoutSeconds: 10, method: 'GET' };
  const result = await runCheck(monitor, {
    request: async () => ({ status: 200, body: '', latencyMs: 12, certificateExpiresAt: '2026-11-25T12:00:00.000Z' }),
  });
  assert.deepEqual([result.ok, result.certificateExpiresAt], [true, '2026-11-25T12:00:00.000Z']);
  assert.equal((await runCheck(monitor, { request: async () => Promise.reject(Object.assign(new Error('x'), { code: 'CERT_HAS_EXPIRED' })) })).error, 'tls');
  assert.equal((await runCheck(monitor, { request: async () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' })) })).error, 'dns');

  const owner = await register(app, 'Ssl');
  const row = await store.create('uptimeMonitor', {
    orgId: owner.orgId, projectId: owner.project.id, name: 'Shop', target: 'https://shop.example.com/',
    intervalSeconds: 300, failureThreshold: 2, status: 'pending',
  });
  const t = Date.now();
  await recordCheckResult(store, row, { ...result, certificateExpiresAt: new Date(t + 10 * 86400000).toISOString() }, null, t);
  const shown = (await owner.client.get('/api/websites')).body.items[0];
  assert.equal(shown.ssl.daysLeft, 9);
  assert.equal(shown.ssl.warning, 14);
  const created = await owner.client.post('/api/alerts/rules/from-template').send({ templateKey: 'ssl_expires_soon' });
  assert.equal(created.status, 201);
  assert.equal(created.body.summary, 'Alert me when the SSL certificate of a website expires in less than 30 days.');
  await evaluateAlerts(store, owner.orgId, { now: t });
  const incident = (await store.list('alertIncident', { orgId: owner.orgId }))[0];
  assert.equal(incident.name, 'SSL certificate expires soon on Shop');
  await deliverNotifications(store, owner.orgId, { now: t });
  assert.match(sent.email[0].text, /expires in 10 days/);
});

const bootstrap = { services: [[['com', 'net'], ['https://rdap.verisign.example/com/v1/']], [['dev'], ['http://insecure.example/', 'https://rdap.dev.example/']]] };
const rdapDomain = { objectClassName: 'domain', events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }, { eventAction: 'expiration', eventDate: '2026-12-05T00:00:00Z' }] };

test('RDAP: domain names, bootstrap lookup, expiry parsing, unsupported TLDs and caching', async () => {
  assert.equal(registrableDomain('www.shop.Example.com'), 'example.com');
  assert.equal(registrableDomain('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('127.0.0.1'), null);
  assert.equal(registrableDomain('localhost'), null);
  assert.equal(parseRdapExpiry(rdapDomain).toISOString(), '2026-12-05T00:00:00.000Z');
  assert.equal(parseRdapExpiry({ events: [] }), null);
  assert.equal(rdapServerFor(bootstrap, 'dev'), 'https://rdap.dev.example/');
  assert.equal(rdapServerFor(bootstrap, 'zz'), null);

  resetRdapCache();
  const calls = [];
  const fetchJson = async (url) => {
    calls.push(url);
    if (url.includes('iana')) return bootstrap;
    if (url.includes('verisign')) return rdapDomain;
    throw new Error('should not be called');
  };
  const ok = await lookupDomainExpiry('example.com', { fetchJson });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.expiresAt.toISOString(), '2026-12-05T00:00:00.000Z');
  assert.equal(calls[1], 'https://rdap.verisign.example/com/v1/domain/example.com');
  assert.equal((await lookupDomainExpiry('thing.zz', { fetchJson })).status, 'unsupported');
  assert.equal(calls.filter((c) => c.includes('iana')).length, 1, 'bootstrap is cached');
  resetRdapCache();
  const down = await lookupDomainExpiry('example.com', { fetchJson: async () => Promise.reject(new Error('boom')) });
  assert.equal(down.status, 'error');
});

test('domain expiry is refreshed by the worker, shown with warning bands and can alert', async () => {
  resetRdapCache();
  const owner = await register(app, 'Domain');
  const now = Date.now();
  const row = await store.create('uptimeMonitor', {
    orgId: owner.orgId, projectId: owner.project.id, name: 'Brand', target: 'https://www.example.com/',
    intervalSeconds: 300, failureThreshold: 2, status: 'healthy', domain: 'example.com',
  });
  const soon = new Date(now + 20 * 86400000).toISOString();
  const fetchJson = async (url) =>
    url.includes('iana') ? bootstrap : { events: [{ eventAction: 'expiration', eventDate: soon }] };
  assert.equal(await refreshDomainExpiry(store, { now, fetchJson }), 1);
  assert.equal(await refreshDomainExpiry(store, { now: now + 1000, fetchJson }), 0, 'looked up at most once a day');
  const shown = (await owner.client.get('/api/websites')).body.items[0];
  assert.equal(shown.domain.name, 'example.com');
  assert.equal(shown.domain.status, 'ok');
  assert.equal(shown.domain.daysLeft, 19);
  assert.equal(shown.domain.warning, 30);
  await owner.client.post('/api/alerts/rules/from-template').send({ templateKey: 'domain_expires_soon' });
  await evaluateAlerts(store, owner.orgId, { now });
  const incident = (await store.list('alertIncident', { orgId: owner.orgId }))[0];
  assert.equal(incident.name, 'Domain expires soon on Brand');
  assert.equal((await monitorRow(row.id)).domainStatus, 'ok');
});
