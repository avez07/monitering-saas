// Prepare the integration-test database: create it if needed, then apply every migration.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { config } from '../src/config.js';
import { testDatabaseUrl } from '../test/db-url.js';

const target = new URL(testDatabaseUrl());
const name = decodeURIComponent(target.pathname.slice(1));
if (!/^[a-z0-9_]+$/.test(name))
  throw new Error('Test database name must be lowercase letters, digits, or _.');
// Never run destructive test setup against the main database.
if (target.pathname === new URL(config.DATABASE_URL).pathname)
  throw new Error('TEST_DATABASE_URL must point to a different database than DATABASE_URL.');
const admin = new URL(target);
admin.pathname = '/postgres';
const client = new PrismaClient({ datasources: { db: { url: admin.toString() } } });
try {
  const rows = await client.$queryRaw`SELECT 1 FROM pg_database WHERE datname = ${name}`;
  if (!rows.length) await client.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
} finally {
  await client.$disconnect();
}
const cli = fileURLToPath(new URL('../../node_modules/prisma/build/index.js', import.meta.url));
const result = spawnSync(process.execPath, [cli, 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: target.toString() },
  cwd: fileURLToPath(new URL('../', import.meta.url)),
});
process.exit(result.status ?? 1);
