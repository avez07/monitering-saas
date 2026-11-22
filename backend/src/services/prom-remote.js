import { createHash } from 'node:crypto';
import protobuf from 'protobufjs';
import snappy from 'snappyjs';
import { getRedis } from '../lib/redis.js';
import { vmWrite } from '../lib/victoria.js';

/**
 * Prometheus remote_write v1 (prompb.WriteRequest), as much of it as we relay. Exemplars and native
 * histograms are not declared, so protobufjs skips them and they are not forwarded.
 */
const PROTO = `
syntax = "proto3";
package prometheus;
message WriteRequest { repeated TimeSeries timeseries = 1; repeated MetricMetadata metadata = 3; }
message TimeSeries { repeated Label labels = 1; repeated Sample samples = 2; }
message Label { string name = 1; string value = 2; }
message Sample { double value = 1; int64 timestamp = 2; }
message MetricMetadata { int32 type = 1; string metric_family_name = 2; string help = 4; string unit = 5; }
`;
const WriteRequest = protobuf.parse(PROTO).root.lookupType('prometheus.WriteRequest');

/** Largest decompressed body (snappy says its length up front, so this is checked before inflating). */
export const MAX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
export const MAX_LABELS = 40;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_LABEL_VALUE = 2048;

/** Snappy-compressed protobuf -> WriteRequest message. Throws a plain Error when the body is invalid. */
export function decodeWriteRequest(compressed) {
  if (!compressed?.length) throw new Error('The body is empty.');
  const raw = snappy.uncompress(compressed, MAX_UNCOMPRESSED_BYTES);
  return WriteRequest.decode(Buffer.from(raw));
}
/** WriteRequest (message or plain object) -> snappy-compressed protobuf Buffer. */
export function encodeWriteRequest(request) {
  const message = request instanceof WriteRequest.ctor ? request : WriteRequest.fromObject(request);
  return Buffer.from(snappy.compress(Buffer.from(WriteRequest.encode(message).finish())));
}

/**
 * Make the batch ours: drop every `yk_*` label the agent sent (the tenant is never trusted from the agent),
 * add `yk_org` and `yk_agent`, and drop malformed series (no name, bad label names, too many labels).
 * Mutates and returns the request with `{ series, samples, dropped, hashes }` counts.
 */
export function relabel(request, { orgId, agentId }) {
  const kept = [];
  const hashes = [];
  let samples = 0;
  let dropped = 0;
  for (const ts of request.timeseries ?? []) {
    const labels = (ts.labels ?? []).filter((l) => !String(l.name).startsWith('yk_'));
    const valid =
      labels.length < MAX_LABELS &&
      labels.some((l) => l.name === '__name__' && l.value) &&
      labels.every((l) => LABEL_NAME.test(l.name) && String(l.value ?? '').length <= MAX_LABEL_VALUE) &&
      new Set(labels.map((l) => l.name)).size === labels.length;
    if (!valid || !ts.samples?.length) {
      dropped++;
      continue;
    }
    labels.push({ name: 'yk_org', value: orgId }, { name: 'yk_agent', value: agentId });
    labels.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    ts.labels = labels;
    kept.push(ts);
    samples += ts.samples.length;
    hashes.push(seriesHash(labels));
  }
  request.timeseries = kept;
  return { request, series: kept.length, samples, dropped, hashes };
}
const seriesHash = (labels) =>
  createHash('sha1')
    .update(labels.map((l) => `${l.name}\u0000${l.value}`).join('\u0001'))
    .digest('base64')
    .slice(0, 12);

/**
 * Cardinality guard: the distinct series an organization wrote this hour (HyperLogLog, ~1% error).
 * Returns `{ over, count }`; once over the cap, every write that hour is refused with 429.
 */
export async function trackSeries(orgId, hashes, cap, now = Date.now()) {
  if (!hashes.length) return { over: false, count: 0 };
  const key = `prom:series:${orgId}:${Math.floor(now / 3600000)}`;
  const redis = getRedis();
  const multi = redis.multi();
  for (let i = 0; i < hashes.length; i += 5000) multi.pfadd(key, ...hashes.slice(i, i + 5000));
  multi.pfcount(key).expire(key, 7200);
  const results = await multi.exec();
  const count = Number(results.at(-2)[1]) || 0;
  return { over: count > cap, count };
}

const SEEN_TTL = 35 * 86400;
const seenMemo = new Map(); // agentId -> ms of the last Redis write (one write per agent per minute)
/** Remember which agents of an org sent remote_write data (GET /api/dashboards/targets `hasData`). */
export async function markPromSeen(orgId, agentId, now = Date.now()) {
  if (now - (seenMemo.get(agentId) ?? 0) < 60000) return;
  seenMemo.set(agentId, now);
  if (seenMemo.size > 50000) seenMemo.delete(seenMemo.keys().next().value);
  const key = `prom:seen:${orgId}`;
  await getRedis().multi().hset(key, agentId, String(now)).expire(key, SEEN_TTL).exec();
}
/** `Map<agentId, lastWriteMs>` for one org. */
export async function promSeen(orgId) {
  const all = await getRedis().hgetall(`prom:seen:${orgId}`);
  return new Map(Object.entries(all).map(([id, at]) => [id, Number(at)]));
}
export const forgetPromSeenMemo = () => seenMemo.clear();

/**
 * Bounded, in-process relay to VictoriaMetrics. The write route answers 202 as soon as a batch is queued
 * here; sends run in the background (a few at a time) with a short retry. When too many bytes are waiting,
 * `full()` is true and the route answers 429 so agents back off and keep buffering.
 */
class PromForwarder {
  constructor({ maxPendingBytes = 64 * 1024 * 1024, concurrency = 4, attempts = 4, baseDelayMs = 250 } = {}) {
    Object.assign(this, { maxPendingBytes, concurrency, attempts, baseDelayMs });
    this.queue = [];
    this.active = 0;
    this.pendingBytes = 0;
    this.stats = { sent: 0, dropped: 0, retried: 0 };
    this.waiters = [];
    this.lastLog = 0;
  }
  configure(options = {}) {
    Object.assign(this, options);
  }
  full(bytes = 0) {
    return this.pendingBytes + bytes > this.maxPendingBytes;
  }
  push(body) {
    this.pendingBytes += body.length;
    this.queue.push(body);
    this.#pump();
  }
  #pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const body = this.queue.shift();
      this.active++;
      this.#send(body).finally(() => {
        this.active--;
        this.pendingBytes -= body.length;
        this.#pump();
        if (!this.active && !this.queue.length) for (const resolve of this.waiters.splice(0)) resolve();
      });
    }
  }
  async #send(body) {
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        await vmWrite(body);
        this.stats.sent++;
        return;
      } catch (error) {
        if (error.permanent || attempt === this.attempts) {
          this.stats.dropped++;
          const now = Date.now();
          if (now - this.lastLog > 60000) {
            this.lastLog = now;
            console.error(`prom: dropped a remote_write batch after ${attempt} attempt(s): ${error.message}`);
          }
          return;
        }
        this.stats.retried++;
        await new Promise((resolve) => setTimeout(resolve, this.baseDelayMs * 2 ** (attempt - 1)));
      }
    }
  }
  /** Resolves when nothing is queued or in flight (tests, graceful shutdown). */
  idle() {
    if (!this.active && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
export const promForwarder = new PromForwarder();
