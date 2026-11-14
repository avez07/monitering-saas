#!/usr/bin/env node
// Inspectable, dependency-free development agent. Runs without elevated permissions and opens no ports.
// (The production agent is a Go binary installed with one command; this script is the dev stand-in.)
//
//   First run:  node backend/scripts/agent.mjs --enroll <token> --api https://api.yuktiops.com
//   Later runs: node backend/scripts/agent.mjs
import os from 'node:os';
import { readFile, writeFile, mkdir, statfs } from 'node:fs/promises';
import { join } from 'node:path';

const configDir = process.env.YUKTIOPS_CONFIG_DIR || join(os.homedir(), '.config', 'yuktiops');
const configFile = join(configDir, 'agent.env');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};

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
let credential = process.env.AGENT_TOKEN || saved.AGENT_TOKEN;

async function request(path, body, authenticated = true) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated ? { Authorization: `Bearer ${credential}` } : {}),
    },
    body: JSON.stringify(body),
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
const enrollmentToken = arg('--enroll');
if (process.argv.includes('--enroll') && !enrollmentToken)
  throw new Error('Provide the short-lived enrollment token after --enroll.');
if (enrollmentToken) {
  const enrolled = await request(
    '/api/agents/enroll',
    {
      token: enrollmentToken,
      name: process.env.AGENT_NAME || os.hostname(),
      platform: os.platform(),
      version: '0.1.0',
    },
    false,
  );
  credential = enrolled.token;
  await save({ API_URL: baseUrl, AGENT_TOKEN: credential });
  console.log(`Enrolled ${os.hostname()}. Credential saved to ${configFile}. Starting collection.`);
}
if (!credential)
  throw new Error(
    'Not enrolled yet. Run with --enroll <token> using the command from the dashboard.',
  );

const totals = () =>
  os.cpus().reduce(
    (a, cpu) => {
      a.idle += cpu.times.idle;
      a.total += Object.values(cpu.times).reduce((x, y) => x + y, 0);
      return a;
    },
    { idle: 0, total: 0 },
  );
let previous = totals(),
  stopped = false,
  failures = 0;
process.on('SIGINT', () => {
  stopped = true;
});
process.on('SIGTERM', () => {
  stopped = true;
});
console.log(
  `YuktiOps agent · ${os.hostname()} · ${os.platform()} ${os.arch()} · outbound to ${baseUrl}`,
);
while (!stopped) {
  const current = totals();
  const cpu =
    current.total === previous.total
      ? 0
      : Math.max(
          0,
          Math.min(
            100,
            100 * (1 - (current.idle - previous.idle) / (current.total - previous.total)),
          ),
        );
  previous = current;
  const measurements = {
    cpu: +cpu.toFixed(2),
    memory: +(100 * (1 - os.freemem() / os.totalmem())).toFixed(2),
    cores: os.cpus().length,
    ramGb: +(os.totalmem() / 1024 ** 3).toFixed(2),
    uptimeSeconds: os.uptime(),
    environment: process.env.AGENT_ENVIRONMENT || 'production',
    os: `${os.type()} ${os.release()}`,
  };
  try {
    // Root filesystem (system drive on Windows), not whatever directory the agent was started in.
    const fs = await statfs(
      process.platform === 'win32' ? `${process.env.SystemDrive || 'C:'}\\` : '/',
    );
    measurements.disk = +(100 * (1 - fs.bavail / fs.blocks)).toFixed(2);
  } catch {
    /* Filesystem statistics are not supported on every OS. */
  }
  try {
    await request('/api/agents/heartbeat', measurements);
    failures = 0;
    console.log(
      `${new Date().toISOString()} · CPU ${measurements.cpu}% · Memory ${measurements.memory}% · reported`,
    );
  } catch (error) {
    console.error(`Collection failed: ${error.message}`);
    failures++;
    if ([401, 403].includes(error.status)) {
      console.error(
        'Agent credential is invalid or revoked. Enroll again or rotate the credential.',
      );
      process.exitCode = 1;
      break;
    }
  }
  const delay = Math.min(300000, failures ? 5000 * 2 ** Math.min(failures, 6) : 30000);
  for (let elapsed = 0; elapsed < delay && !stopped; elapsed += 250)
    await new Promise((r) => setTimeout(r, 250));
}
