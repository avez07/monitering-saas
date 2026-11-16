import express, { Router } from 'express';
import { HttpError } from '../lib/errors.js';
import { telemetryKeyAuth, markSeen } from '../services/otel-auth.js';
import { SIGNALS, decodeRequest, encodeResponse, isJsonType, isProtobufType } from '../services/otel-proto.js';
import { countDataPoints, countInvalid } from '../services/otel-transform.js';
import { checkQuota, addUsage, retentionDays } from '../services/otel-usage.js';
import { enqueueOtel, otelOverloaded } from '../queues/otel.js';

const MAX_BODY = Number(process.env.OTEL_MAX_BODY_BYTES) || 4 * 1024 * 1024;
const REQUESTS_PER_MINUTE = 1200;

const retryable = (res, status, retryAfter, code, error) =>
  res.status(status).set('Retry-After', String(retryAfter)).json({ error, code });

/**
 * OTLP/HTTP ingest on the standard paths /v1/traces, /v1/logs and /v1/metrics. These do not overlap the
 * agent protocol (/v1/register, /v1/ingest, ...); the credential differs too (x-yuktiops-key with a
 * yk_otel_ key). The batch is validated, counted against the plan's monthly volume and queued; a worker
 * stores it. Nothing here waits for ClickHouse.
 */
export function otlpRoutes(store, limits) {
  const router = Router();
  const auth = telemetryKeyAuth(store, limits);
  // inflate: gzip request bodies are decompressed (and the limit applies to the decompressed size).
  const body = express.raw({ type: () => true, limit: MAX_BODY, inflate: true });

  for (const signal of SIGNALS) {
    router.post(`/${signal}`, auth, async (req, res, next) => {
      try {
        const { keyId, orgId, planId } = req.otel;
        const contentType = req.headers['content-type'] ?? '';
        if (!isJsonType(contentType) && !isProtobufType(contentType))
          throw new HttpError(415, 'Use Content-Type application/x-protobuf or application/json.');
        // Per-key request rate.
        try {
          await limits.use(`otel:rate:${keyId}`, 1, REQUESTS_PER_MINUTE, 60);
        } catch (error) {
          if (error.status === 429) return retryable(res, 429, 30, 'rate_limited', 'Too many telemetry requests from this key. Batch more data per request.');
          throw error;
        }
        const quota = await checkQuota(orgId, planId);
        if (quota.over)
          return retryable(res, 429, quota.retryAfter, 'quota_exceeded', 'The monthly telemetry volume of your plan is used up. Upgrade or wait for the next month.');
        if (signal !== 'metrics' && (await otelOverloaded()))
          return retryable(res, 503, 5, 'overloaded', 'Telemetry ingest is busy. Retry shortly.');

        await new Promise((resolve, reject) => body(req, res, (error) => (error ? reject(error) : resolve())));
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        let decoded;
        try {
          decoded = decodeRequest(signal, raw, contentType);
        } catch (error) {
          throw new HttpError(400, `The ${signal} body could not be decoded: ${error.message}`);
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
        await Promise.all([addUsage(store, orgId, planId, raw.length, signal), markSeen(keyId, signal)]);
        const payload = encodeResponse(signal, { json, rejected, message });
        if (json) res.json(payload);
        else res.status(200).type('application/x-protobuf').send(payload);
      } catch (error) {
        next(error);
      }
    });
  }
  return router;
}
