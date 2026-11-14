import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { config, root, trustProxyValue } from './config.js';
import { errorHandler } from './lib/errors.js';
import { auth, csrfGuard } from './services/auth.js';
import { authRoutes } from './routes/auth.js';
import { controlRoutes } from './routes/control.js';
import { agentManagementRoutes } from './routes/agents.js';
import { apiKeyRoutes } from './routes/api-key.js';
import { v1Routes } from './routes/v1.js';
import { verifyWebhook, processWebhook } from './services/billing.js';

export function createApp(store, limits) {
  const app = express();
  app.disable('x-powered-by');
  // Behind Caddy/Nginx/Cloudflare req.ip must be the real client, or rate limits hit everyone at once.
  app.set('trust proxy', trustProxyValue());
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          // Chart libraries set inline styles at runtime.
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      strictTransportSecurity:
        config.NODE_ENV === 'production'
          ? { maxAge: 31536000, includeSubDomains: true, preload: false }
          : false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );
  app.use(cors({ origin: config.APP_URL, credentials: true }));
  app.get('/api/health', async (req, res) => {
    try {
      await store.list('subscriptionPlan');
      res.json({ status: 'ok', version: '0.1.0' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });
  // The billing webhook needs the raw body for signature verification, so it runs before the JSON parser.
  app.post(
    '/api/billing/webhook',
    express.raw({ type: 'application/json', limit: '64kb' }),
    async (req, res) => {
      verifyWebhook(req.body, req.headers['x-yuktiops-signature']);
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
          currency: z.enum(['USD', 'INR']).optional(),
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
  // The agent protocol. Bearer credentials only (no cookies), and gzip bodies are accepted. This runs
  // before the small default JSON limit because a batch of buffered samples is larger than a form post.
  app.use('/v1', express.json({ limit: '512kb' }), v1Routes(store, limits));
  app.use(express.json({ limit: '128kb' }));
  // Browser-facing routes use the session cookie and are CSRF-guarded.
  app.use('/api/auth', authRoutes(store, limits));
  const secured = express.Router();
  secured.use(csrfGuard);
  secured.use(auth(store));
  secured.use(controlRoutes(store, limits));
  secured.use(agentManagementRoutes(store));
  secured.use(apiKeyRoutes(store));
  app.use('/api', secured);
  app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
  if (existsSync(`${root}/frontend/dist/index.html`)) {
    app.use(express.static(`${root}/frontend/dist`));
    app.get('/{*path}', (req, res) => res.sendFile(`${root}/frontend/dist/index.html`));
  }
  app.use(errorHandler);
  return app;
}
