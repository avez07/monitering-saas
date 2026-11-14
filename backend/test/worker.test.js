import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { acquireLease, releaseLease, runWorkerTick } from '../src/services/workers.js';
import { setup, closeStore } from './helpers.js';

after(closeStore);

test('only one worker holds the lease; another takes over after release or expiry', async () => {
  const { store } = await setup();
  assert.equal(await acquireLease(store, 'worker-a'), true);
  assert.equal(await acquireLease(store, 'worker-b'), false, 'b must wait while a holds it');
  assert.equal(await acquireLease(store, 'worker-a'), true, 'a can renew its own lease');
  await releaseLease(store, 'worker-a');
  assert.equal(await acquireLease(store, 'worker-b'), true, 'b takes over after release');
  assert.equal(await acquireLease(store, 'worker-a', 1000), false);
  // A crashed worker (lease simply expires) is replaced.
  await store.update('workerLease', 'main-worker', { expiresAt: new Date(Date.now() - 1000) });
  assert.equal(await acquireLease(store, 'worker-a'), true);
});

test('two workers racing for a fresh lease produce exactly one winner', async () => {
  const { store } = await setup();
  const results = await Promise.all(
    ['w1', 'w2', 'w3', 'w4', 'w5'].map((id) => acquireLease(store, id)),
  );
  assert.equal(results.filter(Boolean).length, 1);
});

test('a worker tick runs for the lease holder and is skipped for everyone else', async () => {
  const { store } = await setup();
  assert.equal(await runWorkerTick(store, 'worker-a'), true);
  assert.equal(await runWorkerTick(store, 'worker-b'), false);
});
