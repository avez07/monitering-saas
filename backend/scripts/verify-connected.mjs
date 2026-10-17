// Integration check using an isolated database. Start Docker dependencies first.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { config, root } from '../src/config.js';
import { PrismaStore } from '../src/data/store.js';
import { seed } from '../src/data/seed.js';
import { Limits } from '../src/services/limits.js';
import { createApp } from '../src/app.js';

const target = new URL(config.DATABASE_URL);
target.pathname = '/pulse_integration';
const admin = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
try {
  await admin.$executeRawUnsafe('CREATE DATABASE pulse_integration');
} catch (error) {
  if (!error.message.includes('already exists')) throw error;
} finally {
  await admin.$disconnect();
}
const cli = fileURLToPath(new URL('./prisma.mjs', import.meta.url));
const migrated = spawnSync(process.execPath, [cli, 'migrate', 'deploy'], {
  env: { ...process.env, DATABASE_URL: target.toString() },
  stdio: 'inherit',
});
assert.equal(migrated.status, 0, 'Integration migrations failed');
config.DEMO_MODE = false;
const client = new PrismaClient({ datasourceUrl: target.toString() });
const store = new PrismaStore(client);
const observations = [];
try {
  await seed(store, { demo: false });
  const app = createApp(store, new Limits());
  const email = `integration-${randomUUID()}@pulse.local`;
  const registered = await request(app).post('/api/auth/register').send({
    name: 'Integration Owner',
    email,
    password: config.DEMO_PASSWORD,
    organization: 'Connected integration',
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const headers = { Authorization: `Bearer ${registered.body.token}` };
  const bootstrap = await request(app).get('/api/bootstrap').set(headers);
  assert.equal(bootstrap.status, 200);
  const projectId = bootstrap.body.projects[0].id,
    orgId = bootstrap.body.organization.id;
  const key = await request(app)
    .post('/api/keys')
    .set(headers)
    .send({ name: 'Integration source', projectId });
  assert.equal(key.status, 201);
  const agentHeaders = { Authorization: `Bearer ${key.body.token}` };
  const nano = `${Date.now()}000000`,
    traceId = randomUUID().replaceAll('-', ''),
    spanId = randomUUID().replaceAll('-', '').slice(0, 16);
  const resource = {
    attributes: [{ key: 'service.name', value: { stringValue: 'pulse-integration-service' } }],
  };
  const signals = {
    metrics: {
      resourceMetrics: [
        {
          resource,
          scopeMetrics: [
            {
              scope: { name: 'pulse.integration' },
              metrics: [
                {
                  name: 'pulse.host.cpu.utilization',
                  unit: '%',
                  gauge: { dataPoints: [{ timeUnixNano: nano, asDouble: 42 }] },
                },
              ],
            },
          ],
        },
      ],
    },
    logs: {
      resourceLogs: [
        {
          resource,
          scopeLogs: [
            {
              scope: { name: 'pulse.integration' },
              logRecords: [
                {
                  timeUnixNano: nano,
                  observedTimeUnixNano: nano,
                  severityNumber: 9,
                  severityText: 'INFO',
                  body: { stringValue: 'pulse connected integration passed' },
                },
              ],
            },
          ],
        },
      ],
    },
    traces: {
      resourceSpans: [
        {
          resource,
          scopeSpans: [
            {
              scope: { name: 'pulse.integration' },
              spans: [
                {
                  traceId,
                  spanId,
                  name: 'GET /integration',
                  kind: 2,
                  startTimeUnixNano: nano,
                  endTimeUnixNano: `${BigInt(nano) + 10000000n}`,
                  status: { code: 1 },
                },
              ],
            },
          ],
        },
      ],
    },
  };
  for (const [kind, body] of Object.entries(signals)) {
    const response = await request(app)
      .post(`/otlp/v1/${kind}`)
      .set(agentHeaders)
      .set('X-Scope-OrgID', 'forged-tenant')
      .send(body);
    assert.equal(response.status, 200, `${kind}: ${JSON.stringify(response.body)}`);
    observations.push({ signal: kind, ingest: response.status });
  }
  // Backends index asynchronously. Poll only while there are no results.
  for (const kind of ['metrics', 'logs', 'traces']) {
    let found = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await request(app)
        .get(`/api/query/${kind}`)
        .set(headers)
        .query({ projectId, range: '15m', ...(kind === 'metrics' ? { metric: 'cpu' } : {}) });
      assert.equal(response.status, 200, `${kind} query: ${JSON.stringify(response.body)}`);
      const rows = response.body.points || response.body.entries || response.body.traces;
      if (rows.length) {
        found = true;
        observations.find((o) => o.signal === kind).queryRows = rows.length;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(found, `${kind} did not return ingested telemetry`);
  }
  const trace = await request(app).get(`/api/traces/${traceId}`).set(headers).query({ projectId });
  assert.equal(trace.status, 200, JSON.stringify(trace.body));
  const enrollment = await request(app)
    .post('/api/agents/enrollment-tokens')
    .set(headers)
    .send({ projectId });
  assert.equal(enrollment.status, 201);
  const enrolled = await request(app)
    .post('/api/agents/enroll')
    .send({ token: enrollment.body.token, name: 'integration-host', platform: process.platform });
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  const heartbeat = await request(app)
    .post('/api/agents/heartbeat')
    .set('Authorization', `Bearer ${enrolled.body.token}`)
    .send({ cpu: 10, memory: 30, cores: 4, ramGb: 16, uptimeSeconds: 120, os: 'Integration' });
  assert.equal(heartbeat.status, 200);
  const second = await request(app)
    .post('/api/auth/register')
    .send({
      name: 'Other Owner',
      email: `other-${email}`,
      password: config.DEMO_PASSWORD,
      organization: 'Other isolated tenant',
    });
  assert.equal(second.status, 201);
  const leaked = await request(app)
    .get('/api/query/logs')
    .set('Authorization', `Bearer ${second.body.token}`)
    .query({ range: '15m' });
  assert.equal(leaked.status, 200);
  assert.equal(leaked.body.entries.length, 0);
  const forged = await request(app)
    .get('/api/query/logs')
    .set('Authorization', `Bearer ${second.body.token}`)
    .set('X-Organization-Id', orgId);
  assert.equal(forged.status, 403);
  const result = {
    at: new Date().toISOString(),
    database: 'pulse_integration',
    metadata: 'PostgreSQL migrations, register, keys, enrollment, heartbeat verified',
    telemetry: observations,
    tenantIsolation:
      'second organization has no first-organization telemetry; forged organization rejected',
    traceDetail: trace.status,
  };
  await mkdir(`${root}/docs/verification`, { recursive: true });
  await writeFile(
    `${root}/docs/verification/connected-result.json`,
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await store.close();
}
