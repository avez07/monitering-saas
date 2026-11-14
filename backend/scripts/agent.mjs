#!/usr/bin/env node
// Inspectable, dependency-free development agent. Runs without elevated permissions and opens no ports.
// (The production agent is a Go binary run by systemd; this script speaks the same protocol so the
// backend can be exercised end to end before that binary exists.)
//
//   First run:  node backend/scripts/agent.mjs --register --key yk_live_... --api https://api.yuktiops.com
//   Later runs: node backend/scripts/agent.mjs
//
// The account API key is used once to register this server and is never saved. The server's own
// credential is kept in ~/.config/yuktiops/agent.env (mode 0600).
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFile, writeFile, mkdir, statfs } from 'node:fs/promises';
import { join } from 'node:path';

const VERSION = '0.2.0-dev';
const BUFFER_MS = 15 * 60000; // keep unsent samples for up to 15 minutes
const configDir = process.env.YUKTIOPS_CONFIG_DIR || join(os.homedir(), '.config', 'yuktiops');
const configFile = join(configDir, 'agent.env');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Saved settings: KEY=value lines in the user's config directory (mode 0600), not in a project .env.
async function loadSaved() {
  try {
    return Object.fromEntries(
      (await readFile(configFile, 'utf8'))
        .split(/\r?\n/)
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}
async function save(values) {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(
    configFile,
    Object.entries(values)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
}
const saved = await loadSaved();
const baseUrl = (
  arg('--api') ||
  process.env.YUKTIOPS_API_URL ||
  saved.API_URL ||
  'https://api.yuktiops.com'
).replace(/\/$/, '');
// Credentials must never travel over plain HTTP, except to a server on this very machine.
const { protocol, hostname } = new URL(baseUrl);
if (protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
  console.error(
    `Refusing to send credentials over ${protocol}// to ${hostname}. Use an https:// API URL.`,
  );
  process.exit(1);
}

async function request(method, path, { body, bearer, gzip = false } = {}) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(payload ? { 'Content-Type': 'application/json' } : {}),
      ...(payload && gzip ? { 'Content-Encoding': 'gzip' } : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: payload && gzip ? gzipSync(payload) : payload,
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const failure = new Error(error.error || `Server returned ${response.status}`);
    failure.status = response.status;
    throw failure;
  }
  return response.json();
}

// A stable identity for this machine, so registering again reconnects the same server.
async function machineId() {
  try {
    const id = (await readFile('/etc/machine-id', 'utf8')).trim();
    if (id) return createHash('sha256').update(id).digest('hex');
  } catch {
    /* not Linux, or no machine-id: fall back to an id kept next to the credential */
  }
  const own = saved.MACHINE_ID || randomUUID();
  saved.MACHINE_ID = own;
  return createHash('sha256').update(own).digest('hex');
}

let credential = process.env.AGENT_TOKEN || saved.AGENT_TOKEN;
let settings = null;
let configVersion = null;
if (process.argv.includes('--register')) {
  const key = arg('--key') || process.env.YUKTIOPS_API_KEY;
  if (!key?.startsWith('yk_live_'))
    throw new Error('Provide your account API key after --key (it starts with yk_live_).');
  const registered = await request('POST', '/v1/register', {
    bearer: key,
    body: {
      name: process.env.AGENT_NAME || os.hostname(),
      fingerprint: await machineId(),
      platform: os.platform(),
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      version: VERSION,
      ...(arg('--setup') ? { setupId: arg('--setup') } : {}),
    },
  });
  credential = registered.credential;
  settings = registered.config.settings;
  configVersion = registered.config.version;
  await save({ ...saved, API_URL: baseUrl, AGENT_TOKEN: credential });
  console.log(
    `Registered ${os.hostname()}. Credential saved to ${configFile}. Starting collection.`,
  );
}
if (!credential)
  throw new Error('Not registered yet. Run with --register --key <API key> (see your dashboard).');

// ---- collection -------------------------------------------------------------------------------
const cpuTotals = () =>
  os.cpus().reduce(
    (a, cpu) => {
      a.idle += cpu.times.idle;
      a.total += Object.values(cpu.times).reduce((x, y) => x + y, 0);
      return a;
    },
    { idle: 0, total: 0 },
  );
async function swapPercent() {
  try {
    const m = Object.fromEntries(
      (await readFile('/proc/meminfo', 'utf8')).split('\n').map((l) => l.split(/:\s+/)),
    );
    const total = parseInt(m.SwapTotal, 10);
    return total ? +(100 * (1 - parseInt(m.SwapFree, 10) / total)).toFixed(2) : 0;
  } catch {
    return undefined;
  }
}
async function networkBytes() {
  try {
    let rx = 0,
      tx = 0;
    for (const line of (await readFile('/proc/net/dev', 'utf8')).split('\n').slice(2)) {
      const [name, rest] = line.split(':');
      if (!rest || name.trim() === 'lo') continue;
      const f = rest.trim().split(/\s+/).map(Number);
      rx += f[0];
      tx += f[8];
    }
    return { rx, tx };
  } catch {
    return undefined;
  }
}

let previous = { cpu: cpuTotals(), net: await networkBytes(), at: Date.now() };
async function takeSample(errors) {
  const now = Date.now();
  const cpu = cpuTotals();
  const dt = (now - previous.at) / 1000;
  const dTotal = cpu.total - previous.cpu.total;
  const sample = {
    time: new Date(now).toISOString(),
    cpu: dTotal
      ? +Math.max(0, Math.min(100, 100 * (1 - (cpu.idle - previous.cpu.idle) / dTotal))).toFixed(2)
      : 0,
    memory: +(100 * (1 - os.freemem() / os.totalmem())).toFixed(2),
    uptimeSeconds: Math.round(os.uptime()),
  };
  if (process.platform !== 'win32') sample.load = os.loadavg().map((n) => +n.toFixed(2));
  const swap = await swapPercent();
  if (swap !== undefined) sample.swap = swap;
  const net = await networkBytes();
  if (net && previous.net && dt > 0) {
    sample.netRxBps = Math.max(0, Math.round((net.rx - previous.net.rx) / dt));
    sample.netTxBps = Math.max(0, Math.round((net.tx - previous.net.tx) / dt));
  }
  try {
    // Root filesystem (system drive on Windows), not whatever directory the agent was started in.
    const fs = await statfs(
      process.platform === 'win32' ? `${process.env.SystemDrive || 'C:'}\\` : '/',
    );
    sample.disk = +(100 * (1 - fs.bavail / fs.blocks)).toFixed(2);
  } catch (error) {
    errors.set('disk_unavailable', `Could not read disk usage: ${error.code || error.message}`);
  }
  previous = { cpu, net, at: now };
  return sample;
}
// One reported point averages the samples taken since the last report.
function average(samples) {
  const out = { ...samples[samples.length - 1] };
  for (const key of ['cpu', 'memory', 'swap', 'disk', 'netRxBps', 'netTxBps']) {
    const values = samples.map((s) => s[key]).filter((v) => typeof v === 'number');
    if (values.length) out[key] = +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2);
  }
  return out;
}

// ---- main loop --------------------------------------------------------------------------------
let stopped = false,
  failures = 0;
process.on('SIGINT', () => (stopped = true));
process.on('SIGTERM', () => (stopped = true));
const interval = (envName, fromSettings, fallback) =>
  Number(process.env[envName]) || settings?.[fromSettings] || fallback;
const buffer = [];
let window = [],
  lastSend = 0;
const errors = new Map();

console.log(
  `YuktiOps agent ${VERSION} · ${os.hostname()} · ${os.platform()} ${os.arch()} · outbound to ${baseUrl}`,
);
if (!settings) {
  try {
    ({ settings, version: configVersion } = await request('GET', '/v1/config', {
      bearer: credential,
    }));
  } catch (error) {
    if ([401, 403].includes(error.status)) fatal(error);
    console.error(`Could not load settings (${error.message}); using defaults.`);
  }
}
function fatal(error) {
  console.error(`${error.message} Reinstall the agent from your dashboard to reconnect.`);
  process.exitCode = 1;
  stopped = true;
}

while (!stopped) {
  const sampleEvery = interval('YUKTIOPS_SAMPLE_SECONDS', 'sampleIntervalSeconds', 10);
  const sendEvery = interval('YUKTIOPS_SEND_SECONDS', 'sendIntervalSeconds', 30);
  await sleep(lastSend ? sampleEvery * 1000 : 1000); // the first sample is taken after one second
  if (stopped) break;
  window.push(await takeSample(errors));
  if (lastSend && Date.now() - lastSend < sendEvery * 1000) continue;

  buffer.push(average(window));
  window = [];
  while (buffer.length && Date.now() - new Date(buffer[0].time) > BUFFER_MS) buffer.shift();
  try {
    const result = await request('POST', '/v1/ingest', {
      bearer: credential,
      gzip: true,
      body: {
        sentAt: new Date().toISOString(),
        agent: {
          version: VERSION,
          os: `${os.type()} ${os.release()}`,
          arch: os.arch(),
          cores: os.cpus().length,
          ramBytes: os.totalmem(),
        },
        samples: buffer,
        errors: [...errors].map(([code, message]) => ({ code, message })),
      },
    });
    console.log(
      `${new Date().toISOString()} · CPU ${buffer.at(-1).cpu}% · Memory ${buffer.at(-1).memory}% · sent ${buffer.length}`,
    );
    buffer.length = 0;
    errors.clear();
    failures = 0;
    lastSend = Date.now();
    if (result.config?.version !== configVersion) {
      ({ settings, version: configVersion } = await request('GET', '/v1/config', {
        bearer: credential,
      }));
    }
  } catch (error) {
    console.error(`Could not send data: ${error.message}`);
    lastSend = Date.now();
    if ([401, 403].includes(error.status)) {
      fatal(error);
      break;
    }
    failures++;
    // Back off with jitter so a recovering server is not hit by every agent at once.
    const backoff = Math.min(300, 5 * 2 ** Math.min(failures, 6)) * (0.5 + Math.random());
    for (let t = 0; t < backoff * 1000 && !stopped; t += 250) await sleep(250);
  }
}
