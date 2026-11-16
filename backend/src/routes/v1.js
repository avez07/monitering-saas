import { Router } from 'express';
import { z } from 'zod';
import { assert } from '../lib/errors.js';
import { config } from '../config.js';
import { credentialAuth } from '../services/auth.js';
import { loadAgentContext, stillValid } from '../services/agent-cache.js';
import { apiKeyAuth } from '../services/api-keys.js';
import { entitlements, planLimit } from '../services/limits.js';
import { registerServer } from '../services/agents.js';
import { CONFIG_ID, configForAgent } from '../services/agent-config.js';
import { recordEvent, recordDeduped, trimEvents } from '../services/agent-events.js';
import { digest } from '../lib/crypto.js';
import { SERVICE_KINDS, SERVICE_STATES } from '../services/services.js';
import { enqueueIngest } from '../queues/ingest.js';
import { ingestOverloaded } from '../queues/ingest-queues.js';

const FINGERPRINT = /^[a-f0-9]{64}$/;

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

const REGISTER_PER_IP_HOUR = 2000;
/** Registrations per hour for one API key: three attempts per allowed server (retries, reconnects), at least 120. */
async function registerKeyLimit(store, orgId) {
  try {
    const { plan } = await entitlements(store, orgId);
    const servers = planLimit(plan, 'servers');
    return Number.isFinite(servers) ? Math.max(120, servers * 3) : 5000;
  } catch {
    return 120; // no active subscription: registration itself will be refused
  }
}

const configInfo = (c) => ({ id: c.id, version: c.version });

/**
 * The agent protocol, served at /v1 (api.yuktiops.com/v1/...). The account API key registers a
 * server once; from then on the server uses its own credential. Nothing here is cookie-based.
 */
export function v1Routes(store, limits) {
  const router = Router();

  router.post('/register', apiKeyAuth(store, limits), async (req, res) => {
    // Abuse protection lives in apiKeyAuth (failed keys per IP). Legitimate rollouts are bursty and often share
    // one NAT address, so the IP cap is generous and the per-key cap follows the plan's server limit.
    await limits.use(`register:ip:${req.ip}`, 1, REGISTER_PER_IP_HOUR, 3600);
    await limits.use(
      `register:key:${req.apiKey.id}`,
      1,
      await registerKeyLimit(store, req.apiKey.orgId),
      3600,
    );
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

  router.post('/ingest', async (req, res) => {
    // Agent, resource and setup profile come from a short-lived cache (see services/agent-cache.js).
    const cached = await loadAgentContext(
      store,
      (req.headers.authorization || '').replace(/^Bearer /, ''),
    );
    assert(stillValid(cached), 401, 'Invalid or revoked agent credential.');
    req.credential = cached.credential;
    const { agent, resource, setup } = cached;
    await limits.use(`ingest:${agent.id}`, 1, 30, 60);
    const input = ingestBody.parse(req.body);
    assert(resource && !resource.deletedAt, 403, 'This server was removed from your account.');
    // Backpressure: when the workers are far behind, ask the agent to wait. It keeps buffering (15 minutes)
    // and backs off, so nothing is lost.
    if (await ingestOverloaded())
      return res
        .status(503)
        .set('Retry-After', String(10 + Math.floor(Math.random() * 11)))
        .json({ error: 'The service is busy. Try again shortly.' });
    const now = Date.now();
    // No database work here: the report is validated, queued (gzipped) and answered. Workers store it.
    await enqueueIngest({ agent, input, now, first: agent.status === 'pending' });
    res.status(202).json({ configVersion: setup.version, serverTime: new Date(now).toISOString() });
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
  '/ingest': {
    400: 'invalid_payload',
    401: 'credential_revoked',
    413: 'payload_too_large',
    429: 'rate_limited',
  },
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
