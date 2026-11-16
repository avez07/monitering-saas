import http from 'node:http';
import { config } from './config.js';
import { createStore } from './data/store.js';
import { seedPlans } from './data/seed.js';
import { startRoles, roleNames, registerRole } from './services/workers.js';
import { registerTelegramWebhook } from './services/contacts.js';
import { allowLoopbackForTests } from './services/uptime.js';
import { closeRedis } from './lib/redis.js';
import { ingestRole } from './queues/ingest.js';
import { otelRole } from './queues/otel.js';
registerRole('ingest', ingestRole);
registerRole('otel', otelRole);

/**
 * Background worker, one process per role (or `all` in dev):
 *   node src/worker.js --role=checks|alerts|notify|housekeeping|ingest|otel|all     (default all; env WORKER_ROLE)
 * Each role serves GET /healthz on WORKER_HEALTH_PORT (default per role: all 9100, checks 9101, alerts
 * 9102, notify 9103, housekeeping 9104; 0 turns it off). BullMQ guarantees a scheduled job runs once
 * however many workers run, so scaling out is just starting more processes.
 */
export const DEFAULT_HEALTH_PORTS = { all: 9100, checks: 9101, alerts: 9102, notify: 9103, housekeeping: 9104, ingest: 9105, otel: 9106 };

export function parseRole(argv = process.argv.slice(2), env = process.env) {
  const flag = argv.find((a) => a.startsWith('--role='));
  const index = argv.indexOf('--role');
  return flag?.slice(7) || (index >= 0 ? argv[index + 1] : '') || env.WORKER_ROLE || 'all';
}

/** A tiny HTTP server answering /healthz: 200 while the queue connection works, 503 otherwise. */
export function startHealthServer(port, health) {
  const server = http.createServer(async (req, res) => {
    if (req.url !== '/healthz') {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await health();
      res.writeHead(body.ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    } catch (error) {
      res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: error.message }));
    }
  });
  server.on('error', (error) => console.error(`healthz: ${error.message}`));
  server.listen(port);
  return server;
}

/** Start a worker process in this Node process. Returns { stop }. Exported for tests and embedding. */
export async function startWorkerProcess({ role = 'all', store, healthPort } = {}) {
  if (role !== 'all' && !roleNames().includes(role))
    throw new Error(`Unknown role "${role}". Use ${['all', ...roleNames()].join(', ')}.`);
  const ownStore = !store;
  store ??= await createStore();
  if (ownStore) await seedPlans(store);
  const running = await startRoles(store, role);
  const port = healthPort ?? Number(process.env.WORKER_HEALTH_PORT ?? DEFAULT_HEALTH_PORTS[role] ?? 0);
  const server = port > 0 ? startHealthServer(port, () => running.health()) : null;
  return {
    running,
    server,
    async stop() {
      // Stop taking jobs, let active ones finish, then close servers and connections.
      server?.close();
      await running.stop();
      await closeRedis();
      if (ownStore) await store.close();
    },
  };
}

// Run as a program only when started directly (importing this file in tests has no side effects).
if (/[\\/]worker\.js$/.test(process.argv[1] ?? '')) {
  if (process.env.E2E_ALLOW_LOOPBACK === '1' && config.NODE_ENV !== 'production') allowLoopbackForTests();
  const role = parseRole();
  const worker = await startWorkerProcess({ role });
  if (role === 'all' || role === 'notify')
    registerTelegramWebhook().catch((error) => console.error('Telegram webhook:', error.message));
  console.log(`YuktiOps worker running (role ${role})`);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const force = setTimeout(() => process.exit(1), 30000);
    force.unref();
    await worker.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
