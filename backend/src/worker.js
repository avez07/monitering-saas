import { config } from './config.js';
import { createStore } from './data/store.js';
import { seedPlans } from './data/seed.js';
import { startWorkers } from './services/workers.js';
import { registerTelegramWebhook } from './services/contacts.js';
import { allowLoopbackForTests } from './services/uptime.js';

// Background worker: website checks, alert evaluation, notification delivery, cleanup.
// Run it as its own process (`npm run worker`); a database lease keeps it to one active worker.
if (process.env.E2E_ALLOW_LOOPBACK === '1' && config.NODE_ENV !== 'production')
  allowLoopbackForTests();
const store = await createStore();
await seedPlans(store);
const stop = startWorkers(store);
registerTelegramWebhook().catch((error) => console.error('Telegram webhook:', error.message));
console.log(`YuktiOps worker running (every ${config.WORKER_INTERVAL_MS / 1000}s)`);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();
  await stop();
  await store.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
