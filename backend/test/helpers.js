import request from 'supertest';
import { createApp } from '../src/app.js';
import { createStore } from '../src/data/store.js';
import { seedPlans } from '../src/data/seed.js';
import { hashPassword } from '../src/lib/crypto.js';
import { Limits } from '../src/services/limits.js';
import { config } from '../src/config.js';
import { testDatabaseUrl } from './db-url.js';
import './redis-url.js'; // routes every Redis user in this process to the test DB index
import { getRedis, closeRedis } from '../src/lib/redis.js';
import { resetAgentCache, closeAgentCache } from '../src/services/agent-cache.js';
import { useMemoryMail } from '../src/services/mail.js';
import { drainIngest as drainQueues, resetIngestRuntime } from '../src/queues/ingest.js';
import { closeIngestQueues, setBackpressure } from '../src/queues/ingest-queues.js';
import { closeQueues } from '../src/queues/factory.js';
import { closeSmtp } from '../src/services/contacts.js';

export const PASSWORD = 'correct-horse-battery';
let counter = 0;
let shared;
const extra = [];

/** Empty the test Redis DB (limits, caches, epochs) and drop in-process agent caches. */
export async function flushRedis() {
  await resetIngestRuntime(); // the in-process ingest worker must not outlive the data it was reading
  await getRedis().flushdb();
  resetAgentCache();
  setBackpressure({ maxWaiting: 50000, maxLagMs: 60000 });
}

/**
 * Process everything queued by /v1/ingest so far (rows, container state, events), then flush last-seen
 * times to Postgres. Call it after an ingest request before reading the database or the API.
 */
export function drainIngest() {
  if (!shared) throw new Error('drainIngest() needs setup() to have run.');
  return drainQueues(shared);
}

/** Fresh store + app on the test database, with every table emptied and plans seeded; Redis is flushed too. */
export async function setup() {
  // TRUNCATE below is destructive: refuse to run against the development database.
  if (new URL(testDatabaseUrl()).pathname === new URL(config.DATABASE_URL).pathname)
    throw new Error('Tests must use a database different from DATABASE_URL.');
  shared ||= await createStore(testDatabaseUrl());
  const store = shared;
  const tables = await store.client.$queryRaw`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await store.client.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  await seedPlans(store);
  useMemoryMail(); // account emails are captured in `outbox`, never sent
  await flushRedis();
  const limits = new Limits();
  return { store, limits, app: createApp(store, limits) };
}

/** A second API instance: its own store connection, limiter and agent cache; same database and Redis. */
export async function secondInstance() {
  const store = await createStore(testDatabaseUrl());
  extra.push(store);
  const limits = new Limits();
  return { store, limits, app: createApp(store, limits) };
}

/** A supertest client with a cookie jar that sends the dashboard Origin, like a browser would. */
export function browser(app) {
  return request.agent(app).set('Origin', config.APP_URL);
}

/** Register a brand-new organization through the real API; returns a signed-in browser. */
export async function register(app, name = 'Owner') {
  const n = ++counter;
  const email = `${name.toLowerCase().replace(/\W+/g, '')}${n}@example.com`;
  const client = browser(app);
  const response = await client
    .post('/api/auth/register')
    .send({ name, email, password: PASSWORD, organization: `${name} Org ${n}` });
  if (response.status !== 201)
    throw new Error(`register failed: ${response.status} ${response.text}`);
  const bootstrap = await client.get('/api/bootstrap');
  return {
    client,
    email,
    user: response.body.user,
    orgId: bootstrap.body.organization.id,
    project: bootstrap.body.projects[0],
  };
}

/** Add a member straight into the database (the API has no create-with-password path) and sign them in. */
export async function addMember(app, store, owner, { role, projectIds = [] }) {
  const n = ++counter;
  const email = `${role}${n}@example.com`;
  const user = await store.create('user', {
    name: `${role} ${n}`,
    email,
    passwordHash: hashPassword(PASSWORD),
  });
  const membership = await store.create('organizationMember', {
    orgId: owner.orgId,
    userId: user.id,
    role,
    projectIds,
  });
  const client = browser(app);
  const login = await client.post('/api/auth/login').send({ email, password: PASSWORD });
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${login.text}`);
  return { client, email, user, membership };
}

export async function closeStore() {
  await Promise.all(extra.splice(0).map((s) => s.close()));
  await resetIngestRuntime();
  await closeIngestQueues();
  await shared?.close();
  shared = undefined;
  await closeAgentCache();
  await closeQueues(); // BullMQ queues/workers opened by routes or tests
  closeSmtp();
  await closeRedis();
}
