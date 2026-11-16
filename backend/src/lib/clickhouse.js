import { createClient } from '@clickhouse/client';
import '../config.js'; // loads .env before the values below are read
import { runMigrations } from '../../clickhouse/migrate.js';

/**
 * ClickHouse access for OpenTelemetry data. The client is created lazily, so the API and tests that never
 * touch telemetry do not need ClickHouse. Settings: CLICKHOUSE_URL, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD,
 * CLICKHOUSE_DATABASE (the defaults match docker-compose.yml).
 */
let override = {};
let client = null;
let migrated = null;

/** Point at another database/URL (tests use a throwaway database). */
export function configureClickhouse(next = {}) {
  override = { ...override, ...next };
  const old = client;
  client = null;
  migrated = null;
  old?.close().catch(() => {});
}
const setting = (key, fallback) => override[key] ?? process.env[`CLICKHOUSE_${key.toUpperCase()}`] ?? fallback;
export const clickhouseDatabase = () => setting('database', 'yuktiops_otel');

export function clickhouse() {
  client ??= createClient({
    url: setting('url', 'http://localhost:8123'),
    username: setting('user', 'yuktiops'),
    password: setting('password', 'yuktiops_local_dummy'),
    request_timeout: 30000,
    clickhouse_settings: {
      // Many small batches from workers are merged server-side; wait so a finished job means visible rows.
      async_insert: 1,
      wait_for_async_insert: 1,
      date_time_input_format: 'best_effort',
    },
  });
  return client;
}

/** Create the database and tables once per process (promise cached; a failure is retried on the next call). */
export function ensureSchema() {
  migrated ??= runMigrations(clickhouse(), clickhouseDatabase()).catch((error) => {
    migrated = null;
    throw error;
  });
  return migrated;
}

const t = (name) => `\`${clickhouseDatabase()}\`.${name}`;
export const tables = {
  get traces() { return t('otel_traces'); },
  get logs() { return t('otel_logs'); },
  get red() { return t('otel_red_1m'); },
};

/** Run a SELECT with `{name:Type}` parameters; returns an array of row objects. */
export async function select(query, params = {}) {
  await ensureSchema();
  const result = await clickhouse().query({ query, query_params: params, format: 'JSONEachRow' });
  return result.json();
}
export async function insert(table, values) {
  if (!values.length) return;
  await ensureSchema();
  await clickhouse().insert({ table, values, format: 'JSONEachRow' });
}
export const clickhouseReachable = () => clickhouse().ping().then((r) => r.success, () => false);

export async function closeClickhouse() {
  const c = client;
  client = null;
  migrated = null;
  await c?.close().catch(() => {});
}
