import { createStore } from '../src/data/store.js';
import { seed } from '../src/data/seed.js';
import { config } from '../src/config.js';
const store = await createStore();
await seed(store, { demo: config.DEMO_MODE });
await store.close();
console.log(config.DEMO_MODE ? 'Local demo data ready.' : 'Subscription plans ready. Register the first organization in the app.');
