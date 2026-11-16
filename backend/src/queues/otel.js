import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { getQueue, startWorker, drainQueue } from './factory.js';
import { decodeRequest } from '../services/otel-proto.js';
import { flattenTraces, flattenLogs } from '../services/otel-transform.js';
import { compileRedaction, redactRows } from '../services/otel-redact.js';
import { normalizeSampling, sampleSpans, sampleLogs } from '../services/otel-sampling.js';
import { clickhouseReachable, ensureSchema, insert, tables } from '../lib/clickhouse.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const OTEL_QUEUE = 'otel';
const JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: true,
  removeOnFail: { count: 500 },
};
const otelQueue = () => getQueue(OTEL_QUEUE, { defaultJobOptions: JOB_OPTIONS });

// ------------------------------------------------------------------------------------------- producer

/** Queue one accepted OTLP batch. The raw (already decompressed) body is kept gzip-compressed in Redis. */
export async function enqueueOtel({ orgId, signal, proto, body, retentionDays, receivedAt = Date.now() }) {
  const z = (await gzipAsync(body)).toString('base64');
  await otelQueue().add('batch', { orgId, signal, proto, z, bytes: body.length, retentionDays, receivedAt });
}

// ------------------------------------------------------------------------------------------ backpressure

const pressure = { maxWaiting: Number(process.env.OTEL_MAX_WAITING) || 2000 };
let cached = { at: 0, overloaded: false };
/** Override the queue depth that makes the API answer 503 (tests, tuning). */
export function setOtelBackpressure({ maxWaiting } = {}) {
  if (maxWaiting !== undefined) pressure.maxWaiting = maxWaiting;
  cached = { at: 0, overloaded: false };
}
/** True when the otel workers are too far behind. The verdict is cached for a second. */
export async function otelOverloaded(now = Date.now()) {
  if (now - cached.at < 1000) return cached.overloaded;
  cached = { at: now, overloaded: cached.overloaded };
  try {
    const waiting = await otelQueue().getWaitingCount();
    cached = { at: now, overloaded: waiting > pressure.maxWaiting };
  } catch {
    cached = { at: now, overloaded: false };
  }
  return cached.overloaded;
}

// -------------------------------------------------------------------------------------------- processor

const SETTINGS_TTL_MS = 10000;
const settingsCache = new Map(); // orgId -> { at, value }
/** Forget cached redaction/sampling (the settings route calls this after a save; other processes catch up within 10 s). */
export const clearOtelSettingsCache = () => settingsCache.clear();

async function settingsOf(store, orgId) {
  const hit = settingsCache.get(orgId);
  if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit.value;
  const row = await store.client.telemetrySettings.findUnique({ where: { orgId } });
  const value = {
    rules: Array.isArray(row?.redaction) ? row.redaction : [],
    sampling: normalizeSampling(row?.sampling),
  };
  settingsCache.set(orgId, { at: Date.now(), value });
  return value;
}

let lastSeq = 0;
/** Strictly increasing ids (microsecond clock) for the log live-tail cursor. */
function reserveSeq(count) {
  const start = Math.max(lastSeq + 1, Date.now() * 1000);
  lastSeq = start + count - 1;
  return start;
}

const expireAt = (days, receivedAt) => new Date(receivedAt + days * 86400000).toISOString().slice(0, 19).replace('T', ' ');

/**
 * Decode, sample, redact and insert one batch. Throws (so BullMQ retries) when ClickHouse fails; a body that
 * cannot be decoded is dropped, since retrying cannot fix it.
 */
export async function processOtelJob(store, data) {
  const raw = await gunzipAsync(Buffer.from(data.z, 'base64'));
  let decoded;
  try {
    decoded = decodeRequest(data.signal, raw, data.proto ? 'application/x-protobuf' : 'application/json');
  } catch (error) {
    console.error(`otel: dropping undecodable ${data.signal} batch for ${data.orgId}: ${error.message}`);
    return { stored: 0 };
  }
  const options = { proto: decoded.proto, receivedAt: data.receivedAt };
  const { rules, sampling } = await settingsOf(store, data.orgId);
  const redaction = compileRedaction(data.orgId, rules);
  const expire = expireAt(data.retentionDays, data.receivedAt);
  if (data.signal === 'traces') {
    let { rows } = flattenTraces(decoded.data, options);
    rows = redactRows('traces', sampleSpans(rows, sampling), redaction);
    for (const row of rows) Object.assign(row, { OrgId: data.orgId, ExpireAt: expire });
    await insert(tables.traces, rows);
    return { stored: rows.length };
  }
  if (data.signal === 'logs') {
    let { rows } = flattenLogs(decoded.data, options);
    rows = redactRows('logs', sampleLogs(rows, sampling), redaction);
    const seq = reserveSeq(rows.length);
    rows.forEach((row, i) => Object.assign(row, { OrgId: data.orgId, ExpireAt: expire, IngestSeq: seq + i }));
    await insert(tables.logs, rows);
    return { stored: rows.length };
  }
  return { stored: 0 };
}

export function startOtelWorker(store, options = {}) {
  return startWorker(OTEL_QUEUE, (job) => processOtelJob(store, job.data), { concurrency: 4, ...options });
}

/** Wait until every queued batch has been processed (tests). */
export const drainOtel = (options) => drainQueue(OTEL_QUEUE, options);

/** Worker role: `--role=otel` (and part of `all`). Starts even when ClickHouse is down; jobs then retry. */
export const otelRole = {
  queues: [OTEL_QUEUE],
  async start(store, options = {}) {
    if (await clickhouseReachable()) await ensureSchema().catch((error) => console.error('otel: ClickHouse schema:', error.message));
    else console.error('otel: ClickHouse is not reachable yet; batches will retry until it is.');
    const worker = startOtelWorker(store, options.otel);
    await worker.waitUntilReady();
    return { workers: [worker] };
  },
};
