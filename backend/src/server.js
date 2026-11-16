import { config } from './config.js';
import { createStore } from './data/store.js';
import { seedPlans } from './data/seed.js';
import { createLimits } from './services/limits.js';
import { createApp } from './app.js';
import { closeRedis } from './lib/redis.js';
import { closeAgentCache } from './services/agent-cache.js';
import { allowLoopbackForTests } from './services/uptime.js';

// Browser end-to-end tests monitor a fake site on 127.0.0.1. Never honoured in production.
if (process.env.E2E_ALLOW_LOOPBACK === '1' && config.NODE_ENV !== 'production')
  allowLoopbackForTests();
const store = await createStore();
await seedPlans(store);
const limits = createLimits();
const app = createApp(store, limits);
const server = app.listen(config.PORT, '0.0.0.0', () =>
  console.log(`YuktiOps API: http://localhost:${config.PORT} (${config.NODE_ENV})`),
);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();
  server.close(async () => {
    await store.close();
    await closeAgentCache();
    await closeRedis();
    clearTimeout(force);
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
