import { config } from './config.js';
import { createStore } from './data/store.js';
import { seed } from './data/seed.js';
import { createLimits } from './services/limits.js';
import { startWorkers } from './services/workers.js';
import { createApp } from './app.js';

const store = await createStore();
await seed(store, { demo: config.DEMO_MODE });
const limits = await createLimits();
const app = createApp(store, limits);
const stopWorkers = startWorkers(store, limits);
const server = app.listen(config.PORT, '0.0.0.0', () =>
  console.log(
    `Pulse API: http://localhost:${config.PORT} (${config.DEMO_MODE ? 'demo data; JSON metadata store' : 'PostgreSQL; live telemetry backends'})`,
  ),
);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  stopWorkers();
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();
  server.close(async () => {
    await store.close();
    if (limits.redis) await limits.redis.quit();
    clearTimeout(force);
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
