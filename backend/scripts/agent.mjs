#!/usr/bin/env node
// Inspectable, dependency-free host agent. Runs without elevated permissions.
import os from 'node:os';
import { readFile, writeFile, statfs } from 'node:fs/promises';
import { resolve } from 'node:path';

const envPath = resolve(process.cwd(), '.env');
try {
  process.loadEnvFile(envPath);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const baseUrl = process.env.API_PUBLIC_URL || 'http://localhost:4000';
let credential = process.env.AGENT_TOKEN;
const enrollIndex = process.argv.indexOf('--enroll');
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
if (enrollIndex !== -1) {
  const enrollmentToken = process.argv[enrollIndex + 1];
  if (!enrollmentToken) throw new Error('Provide the short-lived enrollment token after --enroll.');
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
  let content = '';
  try {
    content = await readFile(envPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  content = /^AGENT_TOKEN=.*$/m.test(content)
    ? content.replace(/^AGENT_TOKEN=.*$/m, `AGENT_TOKEN=${credential}`)
    : `${content}\nAGENT_TOKEN=${credential}\n`;
  await writeFile(envPath, content, { mode: 0o600 });
  console.log(`Enrolled ${os.hostname()}. Credential saved to .env. Starting collection.`);
}
if (!credential)
  throw new Error(
    'Set AGENT_TOKEN in .env or enroll first using the command from Agent management.',
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
  `Pulse agent · ${os.hostname()} · ${os.platform()} ${os.arch()} · outbound to ${baseUrl}`,
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
    const fs = await statfs(process.cwd());
    measurements.disk = +(100 * (1 - fs.bavail / fs.blocks)).toFixed(2);
  } catch {
    /* Filesystem statistics are not supported on every OS. */
  }
  try {
    await request('/api/agents/heartbeat', measurements);
    const timeUnixNano = `${Date.now()}000000`;
    const metrics = ['cpu', 'memory', 'disk']
      .filter((k) => measurements[k] !== undefined)
      .map((k) => ({
        name: `pulse.host.${k}.utilization`,
        unit: '%',
        gauge: { dataPoints: [{ timeUnixNano, asDouble: measurements[k] }] },
      }));
    await request('/otlp/v1/metrics', {
      resourceMetrics: [
        {
          resource: {
            attributes: [
              { key: 'host.name', value: { stringValue: os.hostname() } },
              { key: 'service.name', value: { stringValue: 'pulse-host-agent' } },
            ],
          },
          scopeMetrics: [{ scope: { name: 'pulse.host', version: '0.1.0' }, metrics }],
        },
      ],
    });
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
