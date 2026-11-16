// npm run ch:migrate -w backend  (uses CLICKHOUSE_URL / CLICKHOUSE_USER / CLICKHOUSE_PASSWORD / CLICKHOUSE_DATABASE)
import { clickhouse, clickhouseDatabase, closeClickhouse } from '../src/lib/clickhouse.js';
import { runMigrations } from './migrate.js';

try {
  const applied = await runMigrations(clickhouse(), clickhouseDatabase());
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'ClickHouse schema is up to date.');
} finally {
  await closeClickhouse();
}
