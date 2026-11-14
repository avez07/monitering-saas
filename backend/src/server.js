import { config } from './config.js';
import { createStore } from './data/store.js';
import { seedPlans } from './data/seed.js';
import { createLimits } from './services/limits.js';
import { createApp } from './app.js';

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
    clearTimeout(force);
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
