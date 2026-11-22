import express, { Router } from 'express';
import { HttpError, assert } from '../lib/errors.js';
import { telemetryKeyAuth, markSeen, KEY_HEADER } from '../services/otel-auth.js';
import { SIGNALS, decodeRequest, encodeRequest, encodeResponse, isJsonType, isProtobufType } from '../services/otel-proto.js';
import { countDataPoints, countInvalid } from '../services/otel-transform.js';
import { checkQuota, addUsage, retentionDays } from '../services/otel-usage.js';
import { enqueueOtel, otelOverloaded } from '../queues/otel.js';
import { loadAgentContext, stillValid } from '../services/agent-cache.js';
import { orgPlanCached } from '../services/limits.js';
import { assertOrgActive } from '../services/platform-suspension.js';

const MAX_BODY = Number(process.env.OTEL_MAX_BODY_BYTES) || 4 * 1024 * 1024;
const REQUESTS_PER_MINUTE = 1200;

const retryable = (res, status, retryAfter, code, error) =>
  res.status(status).set('Retry-After', String(retryAfter)).json({ error, code });

/**
 * The YuktiOps agent sends container logs with its own credential (`Authorization: Bearer agent_...`)
 * instead of a telemetry key (docs/api/advanced-telemetry.md section 5). Sets the same req.otel shape
 * plus `agentId`.
 */
function agentCredentialAuth(store) {
  return async (req, res, next) => {
    try {
      const cached = await loadAgentContext(store, (req.headers.authorization || '').replace(/^Bearer /, ''));
      assert(stillValid(cached), 401, 'Invalid or revoked agent credential.');
      const { agent, resource } = cached;
      await assertOrgActive(store, agent.orgId);
      assert(resource && !resource.deletedAt, 403, 'This server was removed from your account.');
      const plan = await orgPlanCached(store, agent.orgId);
      assert(plan.planId, 402, 'Your subscription has expired.');
      req.otel = { keyId: `agent:${agent.id}`, orgId: agent.orgId, planId: plan.planId, agentId: agent.id };
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Logs accept either credential: a telemetry key header (apps) or the agent's bearer credential (containers). */
function logsAuth(store, limits) {
  const key = telemetryKeyAuth(store, limits);
  const agent = agentCredentialAuth(store);
  return (req, res, next) =>
    !req.headers[KEY_HEADER] && /^Bearer agent_/.test(req.headers.authorization || '') ? agent(req, res, next) : key(req, res, next);
}

/** Every resource of an agent batch carries the authenticated agent id (never the one the agent claims). */
function stampAgent(data, agentId) {
  for (const rl of data.resourceLogs ?? []) {
    rl.resource ??= {};
    const attrs = (rl.resource.attributes ?? []).filter((a) => a?.key !== 'yk.agent');
    attrs.push({ key: 'yk.agent', value: { stringValue: agentId } });
    if (!attrs.some((a) => a?.key === 'yk.source')) attrs.push({ key: 'yk.source', value: { stringValue: 'docker' } });
    rl.resource.attributes = attrs;
  }
  return data;
}

/**
 * OTLP/HTTP ingest on the standard paths /v1/traces, /v1/logs and /v1/metrics, plus /v1/otlp/logs for the
 * agent's container logs. These do not overlap the agent protocol (/v1/register, /v1/ingest, ...). Apps
 * authenticate with x-yuktiops-key (a yk_otel_ key); the agent uses its own credential for logs. The batch
 * is validated, counted against the plan's monthly volume and queued; a worker stores it. Nothing here
 * waits for ClickHouse.
 */
export function otlpRoutes(store, limits) {
  const router = Router();
  const keyAuth = telemetryKeyAuth(store, limits);
  const anyLogsAuth = logsAuth(store, limits);
  // inflate: gzip request bodies are decompressed (and the limit applies to the decompressed size).
  const body = express.raw({ type: () => true, limit: MAX_BODY, inflate: true });

  const handler = (signal) => async (req, res, next) => {
    try {
      const { keyId, orgId, planId, agentId } = req.otel;
      const contentType = req.headers['content-type'] ?? '';
      if (!isJsonType(contentType) && !isProtobufType(contentType))
        throw new HttpError(415, 'Use Content-Type application/x-protobuf or application/json.');
      // Per-key (or per-agent) request rate.
      try {
        await limits.use(`otel:rate:${keyId}`, 1, REQUESTS_PER_MINUTE, 60);
      } catch (error) {
        if (error.status === 429) return retryable(res, 429, 30, 'rate_limited', 'Too many telemetry requests from this key. Batch more data per request.');
        throw error;
      }
      const quota = await checkQuota(orgId, planId);
      if (quota.over)
        // The agent pauses container logs for 5 minutes on `logs_quota` (docs/api/advanced-telemetry.md section 5).
        return retryable(res, 429, quota.retryAfter, agentId ? 'logs_quota' : 'quota_exceeded', 'The monthly telemetry volume of your plan is used up. Upgrade or wait for the next month.');
      if (signal !== 'metrics' && (await otelOverloaded()))
        return retryable(res, 503, 5, 'overloaded', 'Telemetry ingest is busy. Retry shortly.');

      await new Promise((resolve, reject) => body(req, res, (error) => (error ? reject(error) : resolve())));
      let raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      let decoded;
      try {
        decoded = decodeRequest(signal, raw, contentType);
      } catch (error) {
        throw new HttpError(400, `The ${signal} body could not be decoded: ${error.message}`);
      }
      if (agentId) {
        stampAgent(decoded.data, agentId);
        raw = decoded.proto ? encodeRequest(signal, decoded.data) : Buffer.from(JSON.stringify(decoded.data));
      }
      const json = !decoded.proto;
      let rejected = 0;
      let message = '';
      if (signal === 'metrics') {
        rejected = countDataPoints(decoded.data);
        message = 'Metrics are not stored yet.';
      } else {
        rejected = countInvalid(signal, decoded.data, decoded.proto);
        if (rejected) message = 'Some spans had no valid trace id or span id and were dropped.';
        await enqueueOtel({
          orgId,
          signal,
          proto: decoded.proto,
          body: raw,
          retentionDays: retentionDays(planId),
        });
      }
      await Promise.all([addUsage(store, orgId, planId, raw.length, signal), agentId ? null : markSeen(keyId, signal)]);
      const payload = encodeResponse(signal, { json, rejected, message });
      if (json) res.json(payload);
      else res.status(200).type('application/x-protobuf').send(payload);
    } catch (error) {
      next(error);
    }
  };

  for (const signal of SIGNALS) router.post(`/${signal}`, signal === 'logs' ? anyLogsAuth : keyAuth, handler(signal));
  // The agent's container logs (agent credential only).
  router.post('/otlp/logs', agentCredentialAuth(store), handler('logs'));
  return router;
}
