import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('./migrations/', import.meta.url));
const SPLIT = /^-- split\s*$/m;

/** Statements of one migration file with {db} filled in; comment-only chunks are dropped. */
export function statementsOf(sql, database) {
  return sql
    .split(SPLIT)
    .map((s) => s.replaceAll('{db}', `\`${database}\``).trim())
    .filter((s) => s.replace(/^--.*$/gm, '').trim());
}

/**
 * Create the database and apply every `migrations/NNNN_name.sql` that has not run yet. `client` is a
 * @clickhouse/client instance. Idempotent and safe to call on every worker start.
 */
export async function runMigrations(client, database) {
  if (!/^[A-Za-z0-9_]+$/.test(database)) throw new Error(`Invalid ClickHouse database name "${database}".`);
  await client.command({ query: `CREATE DATABASE IF NOT EXISTS \`${database}\`` });
  await client.command({
    query: `CREATE TABLE IF NOT EXISTS \`${database}\`.schema_migrations (name String, appliedAt DateTime DEFAULT now()) ENGINE = MergeTree ORDER BY name`,
  });
  const rows = await (
    await client.query({ query: `SELECT name FROM \`${database}\`.schema_migrations`, format: 'JSONEachRow' })
  ).json();
  const done = new Set(rows.map((r) => r.name));
  const applied = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    for (const query of statementsOf(readFileSync(dir + file, 'utf8'), database)) await client.command({ query });
    await client.insert({ table: `\`${database}\`.schema_migrations`, values: [{ name: file }], format: 'JSONEachRow' });
    applied.push(file);
  }
  return applied;
}
