// Starts what the browser tests need: the API and the worker (website checks, alerts, email) on a
// dedicated database. Playwright runs this and waits for /api/health; stopping it stops both.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { API_PORT, API_URL, DATABASE_URL, WEB_URL } from './env.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const name = decodeURIComponent(new URL(DATABASE_URL).pathname.slice(1));
if (!/^[a-z0-9_]+$/.test(name))
  throw new Error('The e2e database name must be lowercase letters, digits or _.');

// Create the database if needed (never drops anything), then apply migrations.
const admin = new URL(DATABASE_URL);
admin.pathname = '/postgres';
const client = new PrismaClient({ datasources: { db: { url: admin.toString() } } });
try {
  const rows = await client.$queryRaw`SELECT 1 FROM pg_database WHERE datname = ${name}`;
  if (!rows.length) await client.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
} finally {
  await client.$disconnect();
}
const env = {
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL,
  PORT: String(API_PORT),
  APP_URL: WEB_URL,
  API_PUBLIC_URL: API_URL,
  WORKER_INTERVAL_MS: '3000',
  EMAIL_PROVIDER: 'smtp', // alert and test emails go to Mailpit (SMTP_HOST/SMTP_PORT from .env)
  E2E_ALLOW_LOOPBACK: '1', // lets the website monitor reach the fake site the tests start on 127.0.0.1
};
const migrate = spawnSync(process.execPath, ['backend/scripts/prisma.mjs', 'migrate', 'deploy'], {
  cwd: root,
  env,
  stdio: 'inherit',
});
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

const children = ['backend/src/server.js', 'backend/src/worker.js'].map((file) =>
  spawn(process.execPath, [file], { cwd: root, env, stdio: 'inherit' }),
);
const stop = () => {
  for (const child of children) child.kill();
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) child.on('exit', (code) => code && process.exit(code));
