import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, closeStore } from './helpers.js';
import { trimMetrics } from '../src/services/housekeeping-steps.js';

after(closeStore);

const jobs = (store, proc) =>
  store.client.$queryRawUnsafe(
    `SELECT COALESCE(c.view_name, j.hypertable_name) AS t, j.config
     FROM timescaledb_information.jobs j
     LEFT JOIN timescaledb_information.continuous_aggregates c ON c.materialization_hypertable_name = j.hypertable_name
     WHERE j.proc_name = '${proc}'`,
  );

test('raw hypertables have retention (chunk drop) and compression policies', async () => {
  const { store } = await setup();
  const retention = new Map((await jobs(store, 'policy_retention')).map((j) => [j.t, j.config]));
  for (const table of ['server_metrics', 'container_metrics']) {
    assert.ok(retention.has(table), `${table} retention policy`);
    assert.equal(retention.get(table).drop_after, '8 days');
  }
  // Aggregates outlive the longest plan (365 days).
  assert.equal(retention.get('server_metrics_1h').drop_after, '400 days');
  assert.equal(retention.get('container_metrics_1h').drop_after, '400 days');
  const compression = new Set((await jobs(store, 'policy_compression')).map((j) => j.t));
  assert.ok(compression.has('server_metrics') && compression.has('container_metrics'));
});

test('container_metrics_1h is a continuous aggregate with a refresh policy', async () => {
  const { store } = await setup();
  const [agg] = await store.client.$queryRaw`
    SELECT view_name FROM timescaledb_information.continuous_aggregates WHERE view_name = 'container_metrics_1h'`;
  assert.ok(agg);
  const refresh = await jobs(store, 'policy_refresh_continuous_aggregate');
  assert.ok(refresh.some((j) => j.t === 'container_metrics_1h'));
});

test('the migration is idempotent', async () => {
  const { store } = await setup();
  const sql = (await import('node:fs')).readFileSync(
    new URL('../prisma/migrations/20261117010000_retention_policies_container_1h/migration.sql', import.meta.url),
    'utf8',
  );
  for (const statement of sql.split(/;\s*\n/).map((s) => s.replace(/^(\s*--.*\n)+/g, '').trim()).filter(Boolean))
    await store.client.$executeRawUnsafe(statement);
  const retention = await jobs(store, 'policy_retention');
  assert.equal(retention.filter((j) => j.t === 'server_metrics').length, 1);
});

test('trim-metrics housekeeping only verifies the policies', async () => {
  const { store } = await setup();
  assert.deepEqual(await trimMetrics(store), []);
});
