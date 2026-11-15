import { Router } from 'express';
import { z } from 'zod';
import { assert } from '../lib/errors.js';
import { config } from '../config.js';
import { credentialAuth } from '../services/auth.js';
import { apiKeyAuth } from '../services/api-keys.js';
import { registerServer } from '../services/agents.js';
import { CONFIG_ID, configForAgent } from '../services/agent-config.js';
import { recordEvent, recordDeduped, trimEvents } from '../services/agent-events.js';
import { digest } from '../lib/crypto.js';
import { insertSamples, sampleToRow } from '../services/metrics.js';
import { recordContainers, trimStateEvents } from '../services/containers.js';
import { recordServices, SERVICE_KINDS, SERVICE_STATES } from '../services/services.js';

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
const bytes = z.number().min(0).max(1e16);
const container = z.object({
  id: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/),
  name: z
    .string()
    .max(200)
    .transform((n) => n.replace(/^\/+/, ''))
    .pipe(z.string().min(1)),
  image: z.string().max(300).default(''),
  state: z.enum(['running', 'paused', 'restarting', 'exited', 'created', 'dead', 'removing']),
  status: z.string().max(200).optional(),
  restartCount: z.number().int().min(0).max(1e9).default(0),
  cpuPercent: z.number().min(0).max(1e5).optional(),
  memoryBytes: bytes.optional(),
  memoryLimitBytes: bytes.optional(),
  startedAt: z.string().datetime({ offset: true }).optional(),
  oomKilled: z.boolean().optional(),
});
const service = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(SERVICE_KINDS),
  state: z.enum(SERVICE_STATES),
  detail: z.string().max(200).optional(),
  responseMs: z.number().min(0).max(600000).optional(),
  port: z.number().int().min(1).max(65535).optional(),
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
  // Optional snapshots (see docs/api/agent-ingest-extensions.md): present means complete, absent means off.
  containers: z.array(container).max(100).optional(),
  services: z.array(service).max(100).optional(),
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

    // Container and service snapshots describe "now"; they are stamped with the (clock-corrected) send time.
    const reportedAt = new Date(Math.min(new Date(input.sentAt).getTime() + (skewed ? offset : 0), now));
    if (input.containers) await recordContainers(store, agent, input.containers, { reportedAt, now });
    if (input.services) await recordServices(store, agent, input.services, { reportedAt, now });
    if (input.containers || input.services) await trimStateEvents(store, agent.id, now);

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

    // Agents repeat the same error on every send; keep one event per code every few minutes.
    let events = 0;
    for (const e of input.errors)
      if (
        await recordDeduped(store, {
          orgId: agent.orgId,
          agentId: agent.id,
          source: 'agent',
          code: e.code,
          message: e.message,
        })
      )
        events++;
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

const REJECTION_CODES = {
  '/ingest': { 400: 'invalid_payload', 401: 'credential_revoked', 413: 'payload_too_large', 429: 'rate_limited' },
  '/config': { 401: 'credential_revoked', 429: 'rate_limited' },
  '/register': { 402: 'plan_limit', 413: 'payload_too_large', 429: 'rate_limited' },
};

/**
 * Error middleware for /v1: when we reject a request from a known server (revoked credential, over a
 * limit, too large, invalid), remember why so the Connection page can explain it. Unknown callers are
 * not recorded, so random traffic cannot fill the table. Repeats within 5 minutes are collapsed.
 */
export function v1ErrorRecorder(store) {
  return async (error, req, res, next) => {
    try {
      const status = error.status || (error.name === 'ZodError' ? 400 : 0);
      let code = REJECTION_CODES[req.path]?.[status];
      if (status === 403 && req.path === '/ingest' && /removed/.test(error.message))
        code = 'server_removed';
      if (code) {
        const raw = (req.headers.authorization || '').replace(/^Bearer /, '');
        const credential = raw.startsWith('agent_')
          ? await store.find('agentCredential', { tokenHash: digest(raw) })
          : null;
        const fingerprint = FINGERPRINT.test(req.body?.fingerprint) ? req.body.fingerprint : null;
        const target = credential?.agentId
          ? { orgId: credential.orgId, agentId: credential.agentId }
          : req.apiKey && fingerprint
            ? { orgId: req.apiKey.orgId, agentId: null, fingerprint }
            : null;
        if (target)
          await recordDeduped(store, {
            ...target,
            source: 'server',
            code,
            message: String(error.message).slice(0, 300),
            details: { status, path: `/v1${req.path}` },
          });
      }
    } catch (recordError) {
      console.error('[v1] could not record rejection:', recordError.message);
    }
    next(error);
  };
}
