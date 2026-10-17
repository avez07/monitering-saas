import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { config, root } from './config.js';
import { errorHandler } from './lib/errors.js';
import { auth, requireProject } from './services/auth.js';
import { authRoutes } from './routes/auth.js';
import { controlRoutes } from './routes/control.js';
import {
  agentManagementRoutes,
  enrollmentRoute,
  heartbeatRoute,
  ingestRoute,
} from './routes/agents.js';
import { queryTelemetry, upstream } from './services/telemetry.js';
import { verifyWebhook, processWebhook } from './services/billing.js';
import { entitlements } from './services/limits.js';

export function createApp(store, limits) {
  const app = express();
  app.disable('x-powered-by');
  // The file-backed demo runs as one process. Serialize writes so concurrent demo requests cannot roll each other back.
  let writeQueue = Promise.resolve();
  if (config.DEMO_MODE)
    app.use((req, res, next) => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
      const previous = writeQueue;
      writeQueue = new Promise((resolve) => {
        res.once('finish', resolve);
        res.once('close', resolve);
      });
      previous.then(next);
    });
  app.use(
    cors({
      origin: config.APP_URL,
      allowedHeaders: ['Authorization', 'Content-Type', 'X-Organization-Id'],
    }),
  );
  app.get('/api/health', async (req, res) => {
    try {
      await store.list('subscriptionPlan');
      if (limits.redis) await limits.redis.ping();
      res.json({ status: 'ok', mode: config.DEMO_MODE ? 'demo' : 'connected', version: '0.1.0' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });
  // Raw telemetry and webhook parsers run before the JSON API parser.
  app.post(
    '/otlp/v1/:kind',
    express.raw({ type: ['application/json', 'application/x-protobuf'], limit: '2mb' }),
    ...ingestRoute(store, limits),
  );
  app.post(
    '/api/billing/webhook',
    express.raw({ type: 'application/json', limit: '64kb' }),
    async (req, res) => {
      verifyWebhook(req.body, req.headers['x-pulse-signature']);
      let event;
      try {
        event = JSON.parse(req.body.toString());
      } catch {
        return res.status(400).json({ error: 'Invalid JSON.' });
      }
      event = z
        .object({
          id: z.string().min(1).max(100),
          orgId: z.string().min(1),
          type: z.enum(['payment.succeeded', 'payment.failed', 'subscription.cancelled']),
          amount: z.number().nonnegative().optional(),
        })
        .parse(event);
      try {
        res.json(await processWebhook(store, event));
      } catch (error) {
        if (error.code === 'P2002') return res.json({ duplicate: true });
        throw error;
      }
    },
  );
  app.use(express.json({ limit: '128kb' }));
  app.use('/api/auth', authRoutes(store, limits));
  app.post('/api/agents/enroll', enrollmentRoute(store, limits));
  app.post('/api/agents/heartbeat', ...heartbeatRoute(store, limits));
  const secured = express.Router();
  secured.use(auth(store));
  secured.use(controlRoutes(store, limits));
  secured.use(agentManagementRoutes(store));
  secured.get('/traces/:id', async (req, res) => {
    const traceId = z
      .string()
      .regex(/^[a-f0-9]{32}$/i)
      .parse(req.params.id);
    const projectId = z.string().min(1).parse(req.query.projectId);
    await requireProject(store, req.context, projectId);
    await entitlements(store, req.context.orgId);
    await limits.use(`query:${req.context.orgId}`, 1, config.QUERY_REQUESTS_PER_MINUTE);
    if (config.DEMO_MODE)
      return res.json({
        source: 'demo',
        spans: [
          'HTTP request',
          'Authentication middleware',
          'Database query',
          'Cache lookup',
          'Serialize response',
        ].map((name, i) => ({
          id: i,
          name,
          depth: i ? 1 : 0,
          startPercent: [0, 5, 20, 62, 84][i],
          widthPercent: [100, 12, 39, 18, 13][i],
          durationMs: [124, 15, 48, 22, 16][i],
        })),
      });
    const response = await upstream(`${config.TEMPO_URL}/api/v2/traces/${traceId}`, {
      orgId: req.context.orgId,
      projectId,
    });
    res.json({ source: 'live', trace: await response.json() });
  });
  secured.get('/query/:kind', async (req, res) => {
    const kind = z.enum(['metrics', 'logs', 'traces']).parse(req.params.kind);
    const input = z
      .object({
        projectId: z.string().optional(),
        range: z.enum(['15m', '1h', '6h', '24h']).default('1h'),
        metric: z.enum(['cpu', 'memory', 'throughput', 'errors', 'latency']).optional(),
        search: z.string().max(200).optional(),
        service: z
          .string()
          .regex(/^[a-zA-Z0-9_.:/-]{1,100}$/)
          .optional(),
        level: z.enum(['info', 'warn', 'error', 'debug']).optional(),
      })
      .parse(req.query);
    if (input.projectId) await requireProject(store, req.context, input.projectId);
    await entitlements(store, req.context.orgId);
    await limits.use(`query:${req.context.orgId}`, 1, config.QUERY_REQUESTS_PER_MINUTE);
    res.json(await queryTelemetry(store, req.context, kind, input));
  });
  app.use('/api', secured);
  app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
  if (existsSync(`${root}/frontend/dist/index.html`)) {
    app.use(express.static(`${root}/frontend/dist`));
    app.get('/{*path}', (req, res) => res.sendFile(`${root}/frontend/dist/index.html`));
  }
  app.use(errorHandler);
  return app;
}
