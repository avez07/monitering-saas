import { Router } from 'express';
import { z } from 'zod';
import { assert } from '../lib/errors.js';
import { config } from '../config.js';
import { credentialAuth } from '../services/auth.js';
import { apiKeyAuth } from '../services/api-keys.js';
import { registerServer } from '../services/agents.js';
import { CONFIG_ID, configForAgent } from '../services/agent-config.js';
import { recordEvent, trimEvents } from '../services/agent-events.js';
import { insertSamples, sampleToRow } from '../services/metrics.js';

const FINGERPRINT = /^[a-f0-9]{64}$/;
const BACKFILL_WINDOW_MS = 30 * 60000; // samples buffered through an outage may be up to 30 minutes old
const FUTURE_TOLERANCE_MS = 60000;
const CLOCK_SKEW_MS = 120000; // beyond this, treat the agent's clock as wrong and correct its timestamps
const SKEW_EVENT_EVERY_MS = 10 * 60000;

const percent = z.number().min(0).max(100);
const rate = z.number().min(0).max(1e13);
const sample = z.object({
  time: z.string().datetime({ offset: true }),
  cpu: percent.optional(),
  memory: percent.optional(),
  swap: percent.optional(),
  disk: percent.optional(),
  load: z.array(z.number().min(0).max(1e6)).length(3).optional(),
  netRxBps: rate.optional(),
  netTxBps: rate.optional(),
  diskReadBps: rate.optional(),
  diskWriteBps: rate.optional(),
  uptimeSeconds: z.number().min(0).max(1e10).optional(),
  details: z
    .object({
      mounts: z
        .array(
          z.object({
            path: z.string().max(200),
            percent,
            totalBytes: z.number().min(0).max(1e16).optional(),
            usedBytes: z.number().min(0).max(1e16).optional(),
          }),
        )
        .max(32)
        .optional(),
      interfaces: z
        .array(z.object({ name: z.string().max(64), rxBps: rate, txBps: rate }))
        .max(32)
        .optional(),
      processes: z
        .array(
          z.object({
            name: z.string().max(100),
            pid: z.number().int().min(0).max(1e9),
            cpu: z.number().min(0).max(1e5),
            memBytes: z.number().min(0).max(1e16),
          }),
        )
        .max(20)
        .optional(),
    })
    .optional(),
});
const ingestBody = z.object({
  sentAt: z.string().datetime({ offset: true }),
  agent: z.object({
    version: z.string().max(40),
    os: z.string().max(100).default(''),
    arch: z.string().max(20).default(''),
    cores: z.number().int().min(1).max(4096).optional(),
    ramBytes: z.number().min(0).max(1e16).optional(),
  }),
  samples: z.array(sample).min(1).max(120),
  errors: z
    .array(
      z.object({
        code: z.string().regex(/^[a-z0-9_]{1,60}$/),
        message: z.string().max(300).default(''),
      }),
    )
    .max(20)
    .default([]),
});
const registerBody = z.object({
  name: z.string().trim().min(1).max(100),
  fingerprint: z.string().regex(FINGERPRINT),
  platform: z.string().max(40).default('linux'),
  os: z.string().max(100).default(''),
  arch: z.string().max(20).default(''),
  version: z.string().max(40).default('0.0.0'),
  setupId: z.string().regex(CONFIG_ID).optional(),
});
const installBody = z.object({
  fingerprint: z.string().regex(FINGERPRINT),
  step: z.enum([
    'started',
    'downloaded',
    'verified',
    'installed',
    'registered',
    'service_started',
    'failed',
  ]),
  message: z.string().max(300).default(''),
});

const configInfo = (c) => ({ id: c.id, version: c.version });

/**
 * The agent protocol, served at /v1 (api.yuktiops.com/v1/...). The account API key registers a
 * server once; from then on the server uses its own credential. Nothing here is cookie-based.
 */
export function v1Routes(store, limits) {
  const router = Router();

  router.post('/register', apiKeyAuth(store, limits), async (req, res) => {
    await limits.use(`register:ip:${req.ip}`, 1, 60, 3600);
    await limits.use(`register:key:${req.apiKey.id}`, 1, 120, 3600);
    const input = registerBody.parse(req.body);
    const {
      agent,
      credential,
      reconnected,
      config: setup,
    } = await registerServer(store, req.apiKey, input);
    await recordEvent(store, {
      orgId: agent.orgId,
      agentId: agent.id,
      source: 'install',
      code: 'registered',
      message: reconnected ? 'Server reconnected with a new credential.' : 'Server registered.',
    });
    res.status(reconnected ? 200 : 201).json({
      agentId: agent.id,
      credential,
      endpoint: config.API_PUBLIC_URL,
      reconnected,
      config: { ...configInfo(setup), settings: setup.settings },
    });
  });

  router.post('/install-events', apiKeyAuth(store, limits), async (req, res) => {
    await limits.use(`install-events:${req.apiKey.id}`, 1, 120, 600);
    const input = installBody.parse(req.body);
    const agent = await store.find('agent', {
      orgId: req.apiKey.orgId,
      fingerprint: input.fingerprint,
    });
    await recordEvent(store, {
      orgId: req.apiKey.orgId,
      agentId: agent?.id ?? null,
      fingerprint: input.fingerprint,
      source: 'install',
      code: input.step,
      message: input.message,
    });
    if (agent) await trimEvents(store, agent.id);
    res.status(202).json({ status: 'recorded' });
  });

  router.get('/config', credentialAuth(store), async (req, res) => {
    const agent = await requireAgent(store, req);
    const setup = await configForAgent(store, agent);
    res.json({ ...configInfo(setup), settings: setup.settings });
  });

  router.post('/ingest', credentialAuth(store), async (req, res) => {
    const agent = await requireAgent(store, req);
    await limits.use(`ingest:${agent.id}`, 1, 30, 60);
    const input = ingestBody.parse(req.body);
    const resource = await store.find('monitoredResource', { agentId: agent.id, type: 'server' });
    assert(resource && !resource.deletedAt, 403, 'This server was removed from your account.');
    const now = Date.now();
    const offset = now - new Date(input.sentAt).getTime();
    const skewed = Math.abs(offset) > CLOCK_SKEW_MS;
    // A wrong clock on the server must not lose its data: shift its timestamps by the measured offset.
    const rows = [];
    let dropped = 0;
    for (const s of input.samples) {
      const time = new Date(new Date(s.time).getTime() + (skewed ? offset : 0));
      if (time.getTime() < now - BACKFILL_WINDOW_MS || time.getTime() > now + FUTURE_TOLERANCE_MS) {
        dropped++;
        continue;
      }
      rows.push({ sample: s, row: sampleToRow(agent.orgId, agent.id, s, time) });
    }
    const accepted = await insertSamples(
      store,
      rows.map((r) => r.row),
    );

    const newest = rows.reduce((a, b) => (b.row.time > a.row.time ? b : a), rows[0]);
    const first = agent.status === 'pending';
    await store.update('agent', agent.id, {
      status: 'healthy',
      lastSeen: new Date(),
      version: input.agent.version,
      os: input.agent.os,
      arch: input.agent.arch,
    });
    if (newest) {
      const s = newest.sample;
      const snapshot = Object.fromEntries(
        Object.entries({
          cpu: s.cpu,
          memory: s.memory,
          disk: s.disk,
          uptimeSeconds: s.uptimeSeconds,
          cores: input.agent.cores,
          ramGb: input.agent.ramBytes ? +(input.agent.ramBytes / 1024 ** 3).toFixed(2) : undefined,
          os: input.agent.os || undefined,
        }).filter(([, v]) => v !== undefined),
      );
      const labels = { ...resource.labels, ...snapshot };
      await store.update('monitoredResource', resource.id, {
        labels,
        status: labels.cpu > 85 || labels.memory > 90 ? 'warning' : 'healthy',
      });
    }

    let events = input.errors.length;
    for (const e of input.errors)
      await recordEvent(store, {
        orgId: agent.orgId,
        agentId: agent.id,
        source: 'agent',
        code: e.code,
        message: e.message,
      });
    if (skewed) {
      const recent = await store.client.agentEvent.findFirst({
        where: {
          agentId: agent.id,
          code: 'clock_skew',
          createdAt: { gt: new Date(now - SKEW_EVENT_EVERY_MS) },
        },
      });
      if (!recent) {
        events++;
        await recordEvent(store, {
          orgId: agent.orgId,
          agentId: agent.id,
          source: 'server',
          code: 'clock_skew',
          message: `The server clock is about ${Math.round(Math.abs(offset) / 1000)} seconds ${offset > 0 ? 'behind' : 'ahead of'} real time.`,
          details: { offsetSeconds: Math.round(offset / 1000) },
        });
      }
    }
    if (first)
      await recordEvent(store, {
        orgId: agent.orgId,
        agentId: agent.id,
        source: 'server',
        code: 'first_data',
        message: 'First data received.',
      }).then(() => events++);
    if (events) await trimEvents(store, agent.id);

    const setup = await configForAgent(store, agent);
    res.json({
      accepted,
      dropped,
      config: configInfo(setup),
      serverTime: new Date(now).toISOString(),
    });
  });

  router.use((req, res) => res.status(404).json({ error: 'Unknown agent endpoint.' }));
  return router;
}

/** The authenticated credential must belong to a live server (agent credentials only). */
async function requireAgent(store, req) {
  const { agentId } = req.credential;
  assert(agentId, 403, 'This credential cannot be used by an agent.');
  const agent = await store.find('agent', { id: agentId });
  assert(agent && agent.status !== 'revoked', 401, 'This server has been disconnected.');
  return agent;
}
