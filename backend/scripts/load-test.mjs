import { config, root } from '../src/config.js';
import { writeFile, mkdir } from 'node:fs/promises';
const base = config.API_PUBLIC_URL;
const sessions = [];
for (let i = 0; i < 10; i++) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: i === 0 ? config.DEMO_EMAIL : `pilot${i + 1}@pulse.local`,
      password: config.DEMO_PASSWORD,
    }),
  });
  if (!response.ok)
    throw new Error(`Tenant ${i + 1} login failed. Run against the seeded demo API.`);
  sessions.push((await response.json()).token);
}
const latencies = [],
  errors = [],
  requests = 100;
const start = performance.now();
let cursor = 0;
await Promise.all(
  Array.from({ length: 5 }, async () => {
    while (cursor < requests) {
      const index = cursor++,
        started = performance.now(),
        tenant = index % 10;
      try {
        const response = await fetch(`${base}/api/${index % 2 ? 'resources' : 'overview'}`, {
          headers: { Authorization: `Bearer ${sessions[tenant]}` },
        });
        if (!response.ok) errors.push({ index, status: response.status });
        else await response.json();
      } catch (error) {
        errors.push({ index, error: error.message });
      }
      latencies.push(performance.now() - started);
    }
  }),
);
latencies.sort((a, b) => a - b);
const elapsed = performance.now() - start;
const result = {
  at: new Date().toISOString(),
  mode: 'demo control-plane API; not telemetry storage',
  tenants: 10,
  requests,
  concurrency: 5,
  errors: errors.length,
  durationMs: Math.round(elapsed),
  requestsPerSecond: +((requests / elapsed) * 1000).toFixed(2),
  p50Ms: +latencies[49].toFixed(2),
  p95Ms: +latencies[94].toFixed(2),
  p99Ms: +latencies[98].toFixed(2),
  failures: errors,
};
await mkdir(`${root}/docs/verification`, { recursive: true });
await writeFile(`${root}/docs/verification/load-result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (errors.length) process.exitCode = 1;
