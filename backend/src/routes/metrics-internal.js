import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { getQueue, bullConnection, BULL_PREFIX } from '../queues/factory.js';
import { ingestPressure } from '../queues/ingest-queues.js';

/**
 * Internal observability, never exposed by the edge (deploy/Caddyfile answers 404 for these paths):
 *   GET /metrics          Prometheus text format
 *   /admin/queues         Bull Board, only when BULL_BOARD_USER and BULL_BOARD_PASSWORD are set
 *
 * /metrics access: with METRICS_TOKEN set, `Authorization: Bearer <token>` is required; without it only a
 * direct loopback connection with no X-Forwarded-For (i.e. not through the proxy) is accepted. Anything
 * else gets 404, so the endpoint does not even reveal itself.
 */
export const QUEUE_NAMES = ['ingest', 'side-effects', 'lastseen', 'checks', 'alerts', 'notify', 'housekeeping'];
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export function metricsAllowed(req, env = process.env) {
  const token = env.METRICS_TOKEN;
  if (token) {
    const header = req.headers.authorization || '';
    return header.startsWith('Bearer ') && safeEqual(header.slice(7), token);
  }
  return LOOPBACK.has(req.socket.remoteAddress) && !req.headers['x-forwarded-for'];
}

const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
function lines(out, name, help, type, samples) {
  out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  for (const [labels, value] of samples) {
    const l = Object.entries(labels)
      .map(([k, v]) => `${k}="${esc(v)}"`)
      .join(',');
    out.push(`${name}${l ? `{${l}}` : ''} ${Number.isFinite(value) ? value : 0}`);
  }
}

let failedCache = { at: 0, value: 0 };
async function recentDeliveryFailures(store, now) {
  if (now - failedCache.at < 60000) return failedCache.value;
  try {
    const value = await store.client.notificationDelivery.count({
      where: { status: 'failed', updatedAt: { gt: new Date(now - 3600000) } },
    });
    failedCache = { at: now, value };
  } catch {
    failedCache = { at: now, value: failedCache.value };
  }
  return failedCache.value;
}

/** Render the Prometheus exposition text. Exported for tests. */
export async function renderMetrics(store, { now = Date.now() } = {}) {
  const out = [];
  const depth = [];
  const lag = [];
  for (const name of QUEUE_NAMES) {
    const queue = getQueue(name);
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
    for (const state of ['waiting', 'active', 'delayed', 'failed'])
      depth.push([{ queue: name, state }, counts[state] ?? 0]);
    const oldest = await queue.getWaiting(0, 0);
    lag.push([{ queue: name }, oldest[0] ? Math.max(0, (now - oldest[0].timestamp) / 1000) : 0]);
  }
  lines(out, 'yuktiops_queue_jobs', 'Jobs per queue and state.', 'gauge', depth);
  lines(out, 'yuktiops_queue_lag_seconds', 'Age of the oldest waiting job per queue.', 'gauge', lag);

  const pressure = await ingestPressure(now);
  lines(out, 'yuktiops_ingest_lag_seconds', 'Age of the oldest waiting ingest job (the 503 backpressure signal).', 'gauge', [
    [{}, pressure.lagMs / 1000],
  ]);
  // BullMQ numbers every job it ever added from this counter: it equals ingest requests accepted.
  const client = bullConnection();
  const accepted = Number((await client.get(`${BULL_PREFIX}:ingest:id`)) ?? 0);
  lines(out, 'yuktiops_ingest_accepted_total', 'Ingest requests accepted (jobs ever enqueued).', 'counter', [[{}, accepted]]);
  lines(out, 'yuktiops_notification_failures_1h', 'Deliveries that ended in status failed in the last hour (cached 60 s).', 'gauge', [
    [{}, await recentDeliveryFailures(store, now)],
  ]);
  out.push('');
  return out.join('\n');
}

export function internalRoutes(store, env = process.env) {
  const router = Router();
  router.get('/metrics', async (req, res) => {
    if (!metricsAllowed(req, env)) return res.status(404).end();
    try {
      res.type('text/plain; version=0.0.4; charset=utf-8').send(await renderMetrics(store));
    } catch (error) {
      res.status(503).type('text/plain').send(`# metrics unavailable: ${error.message}\n`);
    }
  });

  // Bull Board: staff only, off unless both variables are set. Loaded lazily so the packages are only
  // needed where it is enabled.
  let board = null;
  router.use('/admin/queues', async (req, res, next) => {
    const user = env.BULL_BOARD_USER;
    const password = env.BULL_BOARD_PASSWORD;
    if (!user || !password) return res.status(404).end();
    const header = req.headers.authorization || '';
    const decoded = Buffer.from(header.startsWith('Basic ') ? header.slice(6) : '', 'base64').toString();
    const at = decoded.indexOf(':');
    const ok =
      at >= 0 && [safeEqual(decoded.slice(0, at), user), safeEqual(decoded.slice(at + 1), password)].every(Boolean);
    if (!ok) return res.status(401).set('WWW-Authenticate', 'Basic realm="YuktiOps queues"').end();
    try {
      if (!board) {
        const [{ createBullBoard }, { BullMQAdapter }, { ExpressAdapter }] = await Promise.all([
          import('@bull-board/api'),
          import('@bull-board/api/bullMQAdapter'),
          import('@bull-board/express'),
        ]);
        const adapter = new ExpressAdapter();
        adapter.setBasePath('/admin/queues');
        createBullBoard({ queues: QUEUE_NAMES.map((n) => new BullMQAdapter(getQueue(n))), serverAdapter: adapter });
        board = adapter.getRouter();
      }
    } catch (error) {
      return res.status(503).type('text/plain').send(`Bull Board is not installed: ${error.message}`);
    }
    board(req, res, next);
  });
  return router;
}
