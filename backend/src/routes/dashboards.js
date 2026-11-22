import { Router } from 'express';
import { z } from 'zod';
import { HttpError, assert } from '../lib/errors.js';
import { requireFeature } from '../services/limits.js';
import { vmQuery } from '../lib/victoria.js';
import { dashboardTargets, findPreset, listPresets } from '../services/dashboards.js';

/** Limits from docs/api/advanced-telemetry.md section 4. */
export const STEP_FLOOR_SECONDS = 15;
export const MAX_POINTS = 11000;
export const QUERIES_PER_MINUTE = 300;
const MAX_RANGE_SECONDS = 32 * 86400; // a little over the 30-day retention

const query = z.string().trim().min(1, 'query is required.').max(5000);
const timeParam = z.string().max(40).optional();

/** Unix seconds (float) or an RFC 3339 time, as the Prometheus API accepts. */
function parseTime(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const seconds = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : Date.parse(value) / 1000;
  assert(Number.isFinite(seconds), 400, `${name} must be a Unix time in seconds or an RFC 3339 time.`);
  return seconds;
}
const UNITS = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
/** Seconds ("30", "30.5") or a Prometheus duration ("30s", "5m"). */
function parseStep(value) {
  if (value === undefined || value === '') return null;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(value);
  assert(match, 400, 'step must be a number of seconds or a duration such as 30s or 5m.');
  return Number(match[1]) * UNITS[match[2]];
}

/**
 * The premium dashboard API (session auth, org scoped). Every PromQL request is proxied to VictoriaMetrics
 * with extra_label=yk_org=<orgId> (lib/victoria.js), so a query can only ever see the caller's series.
 * 402 when the plan does not include `advancedDashboard`.
 */
export function dashboardRoutes(store, limits) {
  const router = Router();
  const entitled = async (req) =>
    requireFeature(store, req.context.orgId, 'advancedDashboard', 'The advanced dashboard is part of the Pro and Business plans. Upgrade to see it.');
  const throttle = async (req) => {
    try {
      await limits.use(`dash:q:${req.context.user.id}`, 1, QUERIES_PER_MINUTE, 60);
    } catch (error) {
      if (error.status === 429)
        throw new HttpError(429, `Too many dashboard queries (more than ${QUERIES_PER_MINUTE} a minute). Expand fewer rows or refresh less often.`, {
          code: 'rate_limited',
        });
      throw error;
    }
  };

  router.get('/dashboards/presets', async (req, res) => {
    await entitled(req);
    res.json(listPresets());
  });
  router.get('/dashboards/presets/:id', async (req, res) => {
    await entitled(req);
    const preset = findPreset(req.params.id);
    assert(preset, 404, 'Dashboard preset not found.');
    res.set('Cache-Control', 'private, max-age=300').json(preset);
  });

  router.get('/dashboards/query_range', async (req, res) => {
    await entitled(req);
    const q = z.object({ query, start: timeParam, end: timeParam, step: z.string().max(20).optional() }).parse(req.query);
    const now = Date.now() / 1000;
    const end = parseTime(q.end, now, 'end');
    const start = parseTime(q.start, end - 3600, 'start');
    assert(start < end, 400, 'start must be before end.');
    assert(end - start <= MAX_RANGE_SECONDS, 400, 'The range can be at most 32 days (data is kept for 30 days).');
    // Step floor, then widen the step so no series has more than MAX_POINTS points.
    let step = Math.max(STEP_FLOOR_SECONDS, parseStep(q.step) ?? (end - start) / 250);
    if ((end - start) / step > MAX_POINTS) step = Math.ceil((end - start) / MAX_POINTS);
    await throttle(req);
    res.json(await vmQuery(req.context.orgId, 'query_range', { query: q.query, start, end, step: `${Math.round(step * 1000) / 1000}s` }));
  });

  router.get('/dashboards/query', async (req, res) => {
    await entitled(req);
    const q = z.object({ query, time: timeParam }).parse(req.query);
    const time = parseTime(q.time, Date.now() / 1000, 'time');
    await throttle(req);
    res.json(await vmQuery(req.context.orgId, 'query', { query: q.query, time }));
  });

  router.get('/dashboards/targets', async (req, res) => {
    await entitled(req);
    res.json(await dashboardTargets(store, req.context.orgId));
  });
  return router;
}
