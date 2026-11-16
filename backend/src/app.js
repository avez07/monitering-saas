import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import { config, root, trustProxyValue } from './config.js';
import { errorHandler } from './lib/errors.js';
import { auth, csrfGuard } from './services/auth.js';
import { authRoutes } from './routes/auth.js';
import { controlRoutes } from './routes/control.js';
import { agentManagementRoutes } from './routes/agents.js';
import { apiKeyRoutes } from './routes/api-key.js';
import { v1Routes, v1ErrorRecorder } from './routes/v1.js';
import { serverRoutes } from './routes/servers.js';
import { connectionRoutes } from './routes/connection.js';
import { teamRoutes, publicInviteRoutes } from './routes/team.js';
import { accountRoutes } from './routes/account.js';
import { alertRoutes } from './routes/alerts.js';
import { contactRoutes, telegramWebhookRoutes } from './routes/contacts.js';
import { websiteRoutes } from './routes/websites.js';
import { containerRoutes } from './routes/containers.js';
import { serviceRoutes } from './routes/services.js';
import { downloadsStatic, releasesRoute } from './routes/downloads.js';
import { billingRoutes, billingWebhookRoutes } from './routes/billing.js';
import { internalRoutes } from './routes/metrics-internal.js';

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
  // /metrics and /admin/queues: internal only (token / loopback / basic auth); the edge never routes them.
  app.use(internalRoutes(store));
  // Provider webhooks need the exact raw body for signature checks, so they run before the JSON parser.
  app.use('/api/webhooks', billingWebhookRoutes(store));
  // The agent protocol. Bearer credentials only (no cookies), and gzip bodies are accepted. This runs
  // before the small default JSON limit because a batch of buffered samples is larger than a form post.
  app.use('/v1', express.json({ limit: '512kb' }), v1Routes(store, limits), v1ErrorRecorder(store));
  // Agent downloads (built by `npm run agent:dist`) and the public release list used by the wizard.
  app.use('/downloads', downloadsStatic());
  app.use(releasesRoute());
  app.use(express.json({ limit: '128kb' }));
  // Browser-facing routes use the session cookie and are CSRF-guarded.
  app.use('/api/auth', authRoutes(store, limits));
  app.use('/api/auth', accountRoutes(store, limits));
  // Invitation links work before sign-in (only the token routes; managing invites is in `secured`).
  app.use('/api/invites', publicInviteRoutes(store, limits));
  // Telegram calls this when someone presses Start on the bot; it authenticates with a secret header.
  app.use('/api/contacts/telegram', telegramWebhookRoutes(store));
  const secured = express.Router();
  secured.use(csrfGuard);
  secured.use(auth(store));
  secured.use(controlRoutes(store, limits));
  secured.use(billingRoutes(store));
  secured.use(agentManagementRoutes(store));
  secured.use(apiKeyRoutes(store));
  secured.use(serverRoutes(store));
  secured.use(connectionRoutes(store));
  secured.use(teamRoutes(store, limits));
  secured.use(alertRoutes(store, limits));
  secured.use(contactRoutes(store));
  secured.use(websiteRoutes(store, limits));
  secured.use(containerRoutes(store));
  secured.use(serviceRoutes(store));
  app.use('/api', secured);
  app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
  if (existsSync(`${root}/frontend/dist/index.html`)) {
    app.use(express.static(`${root}/frontend/dist`));
    app.get('/{*path}', (req, res) => res.sendFile(`${root}/frontend/dist/index.html`));
  }
  app.use(errorHandler);
  return app;
}
