#!/usr/bin/env node
// YuktiOps ingest load test: N simulated agents, one account, gzip batches every interval.
//
//   node deploy/loadtest/loadtest.mjs --api http://localhost:4020 --agents 500 --duration 300
//   node deploy/loadtest/loadtest.mjs --apis http://localhost:4020,http://localhost:4021 --agents 5000 //        --duration 1800 --metrics-token $METRICS_TOKEN
//
// --apis a,b,c   several API instances; agents are assigned round-robin (setup uses the first one).
// Queue lag      every 5 s GET <first api>/metrics (--metrics-url to override, --metrics-token or env
//                METRICS_TOKEN; unauthenticated works only from loopback without a token configured) and
//                report the max and p99 of yuktiops_ingest_lag_seconds and the peak waiting jobs. After the
//                run the script waits for the ingest queue to drain and compares rows in the database
//                with the rows the API accepted (data loss check, direct mode only).
//
// SAFETY: this registers hundreds of servers and writes many rows. It refuses to run against
// anything but localhost unless you pass --i-know-this-is-not-production.
//
// Setup modes
//   default            Creates a throwaway account over HTTP, an API key, then registers the agents
//                      directly in the database (needs DATABASE_URL on localhost) because the public
//                      /v1/register endpoint rightly allows only 60 registrations/hour per IP. It also
//                      lifts the free plan's server cap in that LOCAL database (see raise-limits.sql).
//   --api-key yk_live  Reuse an existing key and register over HTTP (60/h per IP, 120/h per key).
import { gzipSync } from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const flag = (name) => process.argv.includes(name);
if (flag('--help')) {
  console.log(
    'Options: --api URL | --apis URL,URL --metrics-url URL --metrics-token T --agents 500 --duration 300 --interval 30 --samples 1 --api-key KEY --origin URL --keep --out file.json',
  );
  process.exit(0);
}
const apis = (arg('--apis', '') || arg('--api', 'http://localhost:4020'))
  .split(',')
  .map((u) => u.trim().replace(/\/$/, ''))
  .filter(Boolean);
const api = apis[0];
const metricsUrl = arg('--metrics-url', `${api}/metrics`);
const metricsToken = arg('--metrics-token', process.env.METRICS_TOKEN || '');
const agentsN = Number(arg('--agents', 500));
const durationS = Number(arg('--duration', 300));
const intervalS = Number(arg('--interval', 30));
const samplesPer = Number(arg('--samples', 1));
const appOrigin = arg('--origin', 'http://localhost:5173');
const providedKey = arg('--api-key');
const keepData = flag('--keep');
for (const target of apis) {
  const host = new URL(target).hostname;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host) && !flag('--i-know-this-is-not-production')) {
    console.error(`Refusing to load test ${host}. Use a local API, or pass --i-know-this-is-not-production.`);
    process.exit(2);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;
const rnd = (a, b) => a + Math.random() * (b - a);

// ---- setup ---------------------------------------------------------------------------------------
let store = null; // backend store, only in direct mode
let orgId = null;
async function http(method, path, { body, headers = {} } = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json, headers: response.headers };
}

async function createAccountAndKey() {
  const email = `loadtest-${randomBytes(4).toString('hex')}@example.test`;
  const password = randomBytes(12).toString('hex');
  const reg = await http('POST', '/api/auth/register', {
    headers: { Origin: appOrigin },
    body: { name: 'Load Test', email, password, organization: 'Load Test Org' },
  });
  if (reg.status !== 201)
    throw new Error(`Account registration failed (${reg.status}): ${JSON.stringify(reg.json)}`);
  const cookie = (reg.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const key = await http('POST', '/api/api-key', {
    headers: { Origin: appOrigin, Cookie: cookie },
  });
  if (key.status !== 201)
    throw new Error(`API key creation failed (${key.status}): ${JSON.stringify(key.json)}`);
  return key.json.key;
}

const agents = [];
async function setup() {
  const databaseUrl = process.env.DATABASE_URL;
  let raw = providedKey;
  if (!providedKey) {
    if (!databaseUrl) throw new Error('Direct setup needs DATABASE_URL (local test database).');
    if (!/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(databaseUrl))
      throw new Error('Refusing direct database setup: DATABASE_URL is not on localhost.');
    process.env.BILLING_WEBHOOK_SECRET ||= 'loadtest-only-webhook-secret-123456';
    const backend = pathToFileURL(resolve(import.meta.dirname, '../../backend/src')).href;
    const { createStore } = await import(`${backend}/data/store.js`);
    const { registerServer } = await import(`${backend}/services/agents.js`);
    const { digest } = await import(`${backend}/lib/crypto.js`);
    store = await createStore();
    raw = await createAccountAndKey();
    const key = await store.find('apiKey', { tokenHash: digest(raw) });
    orgId = key.orgId;
    await store.client
      .$executeRaw`UPDATE "SubscriptionPlan" SET "includedServers" = ${agentsN + 100} WHERE id = 'free'`;
    const started = performance.now();
    for (let i = 0; i < agentsN; i++) {
      const fingerprint = createHash('sha256').update(`loadtest-${orgId}-${i}`).digest('hex');
      const r = await registerServer(store, key, {
        name: `lt-${String(i).padStart(4, '0')}`,
        fingerprint,
        platform: 'linux',
        os: 'Linux 6.8.0',
        arch: 'amd64',
        version: '0.1.0-loadtest',
      });
      agents.push({ n: i, credential: r.credential, id: r.agent.id });
    }
    console.log(
      `Registered ${agentsN} agents directly in ${((performance.now() - started) / 1000).toFixed(1)}s`,
    );
  } else {
    for (let i = 0; i < agentsN; i++) {
      const fingerprint = createHash('sha256')
        .update(`loadtest-http-${raw.slice(-8)}-${i}`)
        .digest('hex');
      const r = await http('POST', '/v1/register', {
        headers: { Authorization: `Bearer ${raw}` },
        body: { name: `lt-${i}`, fingerprint, os: 'Linux', arch: 'amd64', version: '0.1.0-loadtest' },
      });
      if (r.status === 429) {
        console.warn(`Registration rate limited after ${agents.length} agents (60/h per IP).`);
        break;
      }
      if (r.status >= 300) throw new Error(`register ${r.status}: ${JSON.stringify(r.json)}`);
      agents.push({ n: i, credential: r.json.credential, id: r.json.agentId });
    }
  }
}

// ---- traffic -------------------------------------------------------------------------------------
const latencies = [];
const byStatus = new Map();
let networkErrors = 0;
let acceptedRows = 0;
let sent = 0;
let bytesGz = 0;
let bytesRaw = 0;
const windows = [];
let windowLat = [];
let windowErr = 0;
const t0 = Date.now();

function payload() {
  const now = Date.now();
  const step = (intervalS * 1000) / samplesPer;
  const samples = Array.from({ length: samplesPer }, (_, k) => ({
    time: new Date(now - (samplesPer - 1 - k) * step).toISOString(),
    cpu: +rnd(1, 95).toFixed(2),
    memory: +rnd(20, 90).toFixed(2),
    swap: +rnd(0, 30).toFixed(2),
    disk: +rnd(20, 85).toFixed(2),
    load: [rnd(0, 4), rnd(0, 4), rnd(0, 4)].map((v) => +v.toFixed(2)),
    netRxBps: Math.round(rnd(1e3, 5e6)),
    netTxBps: Math.round(rnd(1e3, 5e6)),
    diskReadBps: Math.round(rnd(0, 2e6)),
    diskWriteBps: Math.round(rnd(0, 2e6)),
    uptimeSeconds: 100000 + Math.round((now - t0) / 1000),
    details: {
      mounts: [
        { path: '/', percent: +rnd(20, 85).toFixed(1), totalBytes: 5e10, usedBytes: 2e10 },
        { path: '/var', percent: +rnd(5, 60).toFixed(1), totalBytes: 2e10, usedBytes: 4e9 },
      ],
      interfaces: [
        { name: 'eth0', rxBps: Math.round(rnd(1e3, 5e6)), txBps: Math.round(rnd(1e3, 5e6)) },
      ],
      processes: Array.from({ length: 10 }, (_, p) => ({
        name: `proc-${p}`,
        pid: 1000 + p,
        cpu: +rnd(0, 30).toFixed(1),
        memBytes: Math.round(rnd(1e7, 5e8)),
      })),
    },
  }));
  return {
    sentAt: new Date(now).toISOString(),
    agent: { version: '0.1.0-loadtest', os: 'Linux 6.8.0', arch: 'amd64', cores: 4, ramBytes: 8 * 1024 ** 3 },
    samples,
    errors: [],
  };
}

async function sendOnce(agent) {
  const target = apis[agent.n % apis.length];
  const raw = Buffer.from(JSON.stringify(payload()));
  const body = gzipSync(raw);
  const started = performance.now();
  try {
    const response = await fetch(`${target}/v1/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        Authorization: `Bearer ${agent.credential}`,
      },
      body,
      signal: AbortSignal.timeout(20000),
    });
    const json = await response.json().catch(() => ({}));
    const ms = performance.now() - started;
    sent++;
    bytesGz += body.length;
    bytesRaw += raw.length;
    byStatus.set(response.status, (byStatus.get(response.status) || 0) + 1);
    latencies.push(ms);
    windowLat.push(ms);
    if (response.ok) acceptedRows += json.accepted ?? samplesPer; // 202 carries no count: one row per sample
    else {
      windowErr++;
      if (windowErr <= 3) console.warn(`HTTP ${response.status}: ${JSON.stringify(json)}`);
    }
  } catch (error) {
    networkErrors++;
    windowErr++;
    if (networkErrors <= 5) console.warn(`network error: ${error.message}`);
  }
}

let stopAt = 0;
async function runAgent(agent) {
  await sleep(rnd(0, intervalS * 1000)); // spread the fleet across the interval like real installs
  while (Date.now() < stopAt) {
    const tick = Date.now();
    await sendOnce(agent);
    await sleep(Math.max(0, intervalS * 1000 * rnd(0.95, 1.05) - (Date.now() - tick)));
  }
}

async function dbReport() {
  if (!store) return null;
  const c = store.client;
  const [metrics] = await c.$queryRaw`SELECT count(*)::int AS n, count(DISTINCT agent_id)::int AS agents FROM server_metrics WHERE org_id = ${orgId}`;
  const [events] = await c.$queryRaw`SELECT count(*)::int AS n FROM "AgentEvent" WHERE "orgId" = ${orgId}`;
  const [conn] = await c.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()`;
  const [size] = await c.$queryRaw`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`;
  return {
    server_metrics_rows: metrics.n,
    agents_with_data: metrics.agents,
    agent_events: events.n,
    db_connections: conn.n,
    database_size: size.size,
  };
}

// ---- queue lag readout (GET /metrics, Prometheus text) -----------------------------------------------
const lagSamples = [];
let peakWaiting = 0;
let metricsErrors = 0;
async function readMetrics() {
  try {
    const response = await fetch(metricsUrl, {
      headers: metricsToken ? { Authorization: `Bearer ${metricsToken}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const lag = /^yuktiops_ingest_lag_seconds (\S+)/m.exec(text);
    const waiting = /^yuktiops_queue_jobs\{queue="ingest",state="waiting"\} (\S+)/m.exec(text);
    const accepted = /^yuktiops_ingest_accepted_total (\S+)/m.exec(text);
    const reading = {
      lagSeconds: lag ? Number(lag[1]) : null,
      waiting: waiting ? Number(waiting[1]) : null,
      accepted: accepted ? Number(accepted[1]) : null,
    };
    if (reading.lagSeconds !== null) lagSamples.push(reading.lagSeconds);
    if (reading.waiting !== null) peakWaiting = Math.max(peakWaiting, reading.waiting);
    return reading;
  } catch (error) {
    if (++metricsErrors <= 2) console.warn(`queue lag readout unavailable (${metricsUrl}): ${error.message}`);
    return null;
  }
}

await setup();
console.log(
  `Sending from ${agents.length} agents every ~${intervalS}s for ${durationS}s (${samplesPer} sample(s) per batch) to ${apis.join(', ')}`,
);
const lagTimer = setInterval(readMetrics, 5000);
stopAt = Date.now() + durationS * 1000;
const ticker = setInterval(() => {
  const s = [...windowLat].sort((a, b) => a - b);
  const w = { at: Math.round((Date.now() - t0) / 1000), requests: s.length, errors: windowErr, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99) };
  windows.push(w);
  console.log(
    `[${String(w.at).padStart(4)}s] req=${w.requests} err=${w.errors} p50=${w.p50.toFixed(0)}ms p95=${w.p95.toFixed(0)}ms p99=${w.p99.toFixed(0)}ms`,
  );
  windowLat = [];
  windowErr = 0;
}, intervalS * 1000);
await Promise.all(agents.map(runAgent));
clearInterval(ticker);
clearInterval(lagTimer);

// Let the workers finish what the API accepted, then compare with what is in the database.
const drainStart = Date.now();
let finalReading = await readMetrics();
while (finalReading && finalReading.waiting > 0 && Date.now() - drainStart < 120000) {
  await sleep(2000);
  finalReading = await readMetrics();
}
const drainSeconds = +((Date.now() - drainStart) / 1000).toFixed(1);

const sorted = [...latencies].sort((a, b) => a - b);
const failures =
  [...byStatus].filter(([s]) => s >= 400).reduce((a, [, n]) => a + n, 0) + networkErrors;
const total = sent + networkErrors;
const report = {
  api,
  agents: agents.length,
  durationSeconds: durationS,
  intervalSeconds: intervalS,
  samplesPerBatch: samplesPer,
  requests: total,
  requestsPerSecond: +(sent / durationS).toFixed(2),
  latencyMs: {
    min: +(sorted[0] ?? 0).toFixed(1),
    p50: +pct(sorted, 50).toFixed(1),
    p95: +pct(sorted, 95).toFixed(1),
    p99: +pct(sorted, 99).toFixed(1),
    max: +(sorted.at(-1) ?? 0).toFixed(1),
  },
  status: Object.fromEntries(byStatus),
  networkErrors,
  errorRatePercent: +((100 * failures) / Math.max(1, total)).toFixed(3),
  acceptedRows,
  apis,
  queueLag: {
    available: lagSamples.length > 0,
    readings: lagSamples.length,
    ingestLagSecondsMax: +Math.max(0, ...lagSamples).toFixed(2),
    ingestLagSecondsP99: +pct([...lagSamples].sort((a, b) => a - b), 99).toFixed(2),
    peakWaitingJobs: peakWaiting,
    secondsToDrainAfterStop: drainSeconds,
  },
  avgPayloadBytes: { raw: Math.round(bytesRaw / Math.max(1, sent)), gzip: Math.round(bytesGz / Math.max(1, sent)) },
  windows,
  db: await dbReport(),
};
console.log('\n=== RESULT ===');
console.log(JSON.stringify({ ...report, windows: undefined }, null, 2));
const out = arg('--out');
if (out) writeFileSync(out, JSON.stringify(report, null, 2));
if (store && !keepData) {
  await store.client.$executeRaw`DELETE FROM server_metrics WHERE org_id = ${orgId}`;
  console.log('Deleted test metrics (use --keep to retain). Drop the test database to clean up fully.');
}
await store?.close();
process.exit(failures ? 1 : 0);
