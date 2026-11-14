import { createStore } from '../src/data/store.js';
import { seedPlans } from '../src/data/seed.js';

const store = await createStore();
await seedPlans(store);
await store.close();
console.log('Subscription plans ready. Register the first organization in the app.');
