import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, closeStore, register } from './helpers.js';
import { enrollServer, registerAgent, ingest, ingestRaw, payload, sample } from './agent-helpers.js';
import { drainIngest } from './helpers.js';

let store, app;
beforeEach(async () => {
  ({ store, app } = await setup());
});
after(closeStore);

test('bulk rollouts register well past the old 60 per hour address cap', async () => {
  const owner = await register(app, 'Rollout');
  const key = (await owner.client.post('/api/api-key')).body.key;
  // Free plan allows 2 servers: the plan limit (402) answers, not the rate limit (429).
  const statuses = [];
  for (let n = 1; n <= 70; n++) statuses.push((await registerAgent(app, key, n)).status);
  assert.deepEqual([...new Set(statuses.slice(0, 2))], [201]);
  assert.ok(
    statuses.slice(2).every((s) => s === 402),
    'never rate limited: ' + [...new Set(statuses)],
  );
});

test('ingest skips no-op writes but still reflects status changes and revocation immediately', async () => {
  const owner = await register(app, 'Cache');
  const s = await enrollServer(app, owner);
  const countQueries = async (fn) => {
    const before = [];
    const client = store.client;
    const originals = {};
    for (const table of ['agent', 'monitoredResource']) {
      originals[table] = client[table].update;
      client[table].update = (...args) => (
        before.push(table),
        originals[table].apply(client[table], args)
      );
    }
    try {
      await fn();
    } finally {
      for (const table of Object.keys(originals)) client[table].update = originals[table];
    }
    return before;
  };
  assert.equal((await ingest(app, s.credential)).status, 202);
  // The request path writes nothing to agent or resource rows: the last-seen flush does it in batches.
  const quiet = await countQueries(async () => {
    assert.equal(
      (
        await ingestRaw(
          app,
          s.credential,
          payload([sample({ time: new Date(Date.now() + 1000).toISOString() })]),
        )
      ).status,
      202,
    );
  });
  assert.deepEqual(quiet, [], 'accepting a report changes nothing in agent or resource rows');
  // A status flip (cpu > 85) is stored when the worker drains and the last-seen flush runs.
  await ingestRaw(
    app,
    s.credential,
    payload([sample({ cpu: 95, time: new Date(Date.now() + 2000).toISOString() })]),
  );
  await drainIngest();
  const resource = await store.find('monitoredResource', { agentId: s.agentId, type: 'server' });
  assert.equal(resource.status, 'warning');
  // Revocation takes effect on the very next request even though the agent is cached.
  assert.equal((await owner.client.delete(`/api/servers/${s.agentId}`)).status, 204);
  assert.equal((await ingest(app, s.credential)).status, 401);
});

test('plan limit messages use the singular for a limit of one', async () => {
  const owner = await register(app, 'Single');
  const invite = await owner.client
    .post('/api/invites')
    .send({ email: 'someone@example.com', role: 'viewer' });
  assert.equal(invite.status, 402);
  assert.match(invite.body.error, /allows 1 member. Upgrade/);
});
