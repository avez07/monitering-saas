import { promisify } from 'node:util';
import { gzip, gunzipSync } from 'node:zlib';
import { Worker } from 'bullmq';
import { createBullConnection, getRedis } from '../lib/redis.js';
import { insertSamples, samplesToRows, liveSnapshot } from '../services/metrics.js';
import { recordContainers, normalizeContainerState, trimStateEvents } from '../services/containers.js';
import { recordServices } from '../services/services.js';
import {
  BULL_PREFIX,
  INGEST_QUEUE,
  LASTSEEN_QUEUE,
  SIDE_EFFECTS_QUEUE,
  closeIngestQueues,
  getQueue,
  ingestQueue,
  sideEffectsQueue,
} from './ingest-queues.js';
import { enqueueSideEffects, startSideEffectsWorker } from './side-effects.js';

const gzipAsync = promisify(gzip);

/**
 * Ingest pipeline (PLAN_2 A.2). The API validates a report, ZADDs the server's last-seen time and
 * enqueues the (gzipped) report; workers drain the queue in batches. Nothing here runs in the request
 * path except `enqueueIngest`.
 */

const LASTSEEN_KEY = 'lastseen'; // ZSET: agentId -> time (ms) of the last accepted report (yk: prefix is added)
const LASTSEEN_FLUSHED_KEY = 'lastseen:flushed';
const LIVE_KEY = 'live'; // HASH: agentId -> latest agent info and snapshot, for the last-seen flush
const CSTATE_KEY = 'cstate'; // HASH: agentId -> last applied container snapshot signature + ids
const SSTATE_KEY = 'sstate'; // HASH: agentId -> last applied service snapshot signature
const REAPPLY_MS = 60000; // an unchanged snapshot still refreshes the DB rows this often
export const LASTSEEN_FLUSH_EVERY_MS = 30000;
const FLUSH_OVERLAP_MS = 5000; // re-flush a little history so a score written during a flush is not missed

// ------------------------------------------------------------------------------------------- producer

/**
 * Called by POST /v1/ingest after validation. Keeps the report gzip-compressed in Redis.
 * `first` is true while the API still sees the server as "pending".
 */
export async function enqueueIngest({ agent, input, now = Date.now(), first = false }) {
  const z = (await gzipAsync(JSON.stringify(input))).toString('base64');
  await Promise.all([
    ingestQueue().add('ingest', { agentId: agent.id, orgId: agent.orgId, receivedAt: now, first, z }),
    getRedis().zadd(LASTSEEN_KEY, now, agent.id),
  ]);
}

// --------------------------------------------------------------------------------------- last seen

/** Record that a server is alive (registration calls this so a server that never reports can still go offline). */
export const touchLastSeen = (agentId, at = Date.now()) => getRedis().zadd(LASTSEEN_KEY, at, agentId);
/** Forget servers (after they were marked offline or removed); the next accepted report adds them back. */
export const forgetLastSeen = (agentIds) =>
  agentIds.length ? getRedis().zrem(LASTSEEN_KEY, ...agentIds) : 0;

/**
 * Servers whose last accepted report is older than `olderThanMs` (ZRANGEBYSCORE), oldest first. This is
 * what offline detection scans instead of loading every agent row. Returns [{ agentId, lastSeenMs }].
 * Servers stay in the set after they go offline unless the caller `forgetLastSeen`s them.
 */
export async function staleAgents({ olderThanMs, now = Date.now(), limit = 5000 }) {
  const flat = await getRedis().zrangebyscore(
    LASTSEEN_KEY,
    '-inf',
    now - olderThanMs,
    'WITHSCORES',
    'LIMIT',
    0,
    limit,
  );
  const out = [];
  for (let i = 0; i < flat.length; i += 2) out.push({ agentId: flat[i], lastSeenMs: Number(flat[i + 1]) });
  return out;
}

/** After Redis lost its data (or on first deploy), rebuild the set from Postgres without lowering any score. */
export async function seedLastSeen(store) {
  const agents = await store.client.agent.findMany({
    where: { status: { notIn: ['revoked', 'offline'] } },
    select: { id: true, lastSeen: true },
  });
  for (let i = 0; i < agents.length; i += 1000) {
    const args = agents.slice(i, i + 1000).flatMap((a) => [a.lastSeen.getTime(), a.id]);
    if (args.length) await getRedis().zadd(LASTSEEN_KEY, 'NX', ...args);
  }
  return agents.length;
}

/**
 * Write last-seen time, agent info and the live resource snapshot/status of every server that reported
 * since the previous flush, in a few multi-row statements. Runs every 30 s (one job for the whole fleet).
 */
export async function flushLastSeen(store, { now = Date.now() } = {}) {
  const redis = getRedis();
  const since = Number(await redis.get(LASTSEEN_FLUSHED_KEY)) || 0;
  let total = 0;
  for (let offset = 0; ; offset += 500) {
    const flat = await redis.zrangebyscore(LASTSEEN_KEY, since, '+inf', 'WITHSCORES', 'LIMIT', offset, 500);
    if (!flat.length) break;
    const ids = [];
    const times = [];
    for (let i = 0; i < flat.length; i += 2) {
      ids.push(flat[i]);
      times.push(new Date(Number(flat[i + 1])).toISOString());
    }
    const lives = (await redis.hmget(LIVE_KEY, ...ids)).map((v) => (v ? JSON.parse(v) : null));
    const db = store.client;
    // Revoked servers keep their status; GREATEST keeps a late flush from moving the time backwards.
    await db.$executeRaw`
      UPDATE "Agent" a SET
        "lastSeen" = GREATEST(a."lastSeen", v.t),
        status = 'healthy',
        version = COALESCE(NULLIF(v.version, ''), a.version),
        os = COALESCE(NULLIF(v.os, ''), a.os),
        arch = COALESCE(NULLIF(v.arch, ''), a.arch),
        "updatedAt" = now()
      FROM unnest(${ids}::text[], ${times}::timestamptz[], ${lives.map((l) => l?.v ?? '')}::text[],
                  ${lives.map((l) => l?.os ?? '')}::text[], ${lives.map((l) => l?.arch ?? '')}::text[])
        AS v(id, t, version, os, arch)
      WHERE a.id = v.id AND a.status <> 'revoked'`;
    const withSnap = ids.map((id, i) => [id, lives[i]?.snap]).filter(([, snap]) => snap);
    if (withSnap.length)
      await db.$executeRaw`
        UPDATE "MonitoredResource" r SET
          labels = m.merged,
          status = CASE WHEN (m.merged->>'cpu')::float8 > 85 OR (m.merged->>'memory')::float8 > 90
                        THEN 'warning' ELSE 'healthy' END,
          "updatedAt" = now()
        FROM (
          SELECT r2.id, r2.labels || v.snap::jsonb AS merged
          FROM unnest(${withSnap.map(([id]) => id)}::text[], ${withSnap.map(([, s]) => JSON.stringify(s))}::text[])
            AS v(agent_id, snap)
          JOIN "MonitoredResource" r2 ON r2."agentId" = v.agent_id AND r2.type = 'server' AND r2."deletedAt" IS NULL
        ) m
        WHERE r.id = m.id`;
    total += ids.length;
    if (flat.length < 1000) break;
  }
  await redis.set(LASTSEEN_FLUSHED_KEY, String(now - FLUSH_OVERLAP_MS));
  return total;
}

// ------------------------------------------------------------------------------------------- batching

/**
 * Collects jobs that BullMQ hands to the processor (with a high concurrency) and writes them together:
 * when `maxRows` samples are waiting or `maxMs` has passed since the first one. Each job's promise
 * settles when its batch is written, so BullMQ only acknowledges what is really stored.
 */
class Batcher {
  constructor(handler, { maxRows, maxMs }) {
    this.handler = handler;
    this.maxRows = maxRows;
    this.maxMs = maxMs;
    this.pending = [];
    this.rows = 0;
    this.timer = null;
    this.chain = Promise.resolve();
    this.busy = 0;
  }
  add(job) {
    return new Promise((resolve, reject) => {
      const input = JSON.parse(gunzipSync(Buffer.from(job.data.z, 'base64')));
      this.pending.push({ job, data: job.data, input, resolve, reject });
      this.rows += input.samples.length + (input.containers?.length ?? 0);
      if (this.rows >= this.maxRows) this.flush();
      else this.timer ||= setTimeout(() => this.flush(), this.maxMs);
    });
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending.length) return this.chain;
    const items = this.pending;
    this.pending = [];
    this.rows = 0;
    this.busy++;
    this.chain = this.chain
      .then(() => this.handler(items))
      .catch((error) => items.forEach((it) => it.reject(error)))
      .finally(() => this.busy--);
    return this.chain;
  }
  get idle() {
    return !this.pending.length && this.busy === 0;
  }
}

const parseHash = (values) => values.map((v) => (v ? JSON.parse(v) : null));
const isDown = (state) => state === 'stopped' || state === 'failed';

const containerSig = (list) =>
  JSON.stringify(
    [...new Map(list.map((c) => [c.name, c])).values()]
      .map((c) => [c.name, c.id, c.image, c.state, c.status ?? '', c.restartCount, c.startedAt ?? '', Boolean(c.oomKilled)])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  );
const serviceSig = (list) =>
  JSON.stringify(
    [...new Map(list.map((s) => [`${s.kind}:${s.name}`, s])).values()]
      .map((s) => [s.kind, s.name, s.state, s.detail ?? '', s.port ?? null])
      .sort((a, b) => (`${a[0]}:${a[1]}` < `${b[0]}:${b[1]}` ? -1 : 1)),
  );

/** Metric rows for containers whose state is unchanged, using the ids remembered from the last full apply. */
function metricRowsFromIds(agent, containers, ids, reportedAt) {
  const rows = [];
  for (const c of new Map(containers.map((x) => [x.name, x])).values())
    if (normalizeContainerState(c.state) !== 'stopped' || c.cpuPercent != null || c.memoryBytes != null)
      rows.push({
        time: reportedAt,
        containerId: ids[c.name],
        agentId: agent.id,
        orgId: agent.orgId,
        cpuPercent: c.cpuPercent ?? null,
        memoryBytes: c.memoryBytes ?? null,
        memoryLimitBytes: c.memoryLimitBytes || null,
        restartCount: c.restartCount,
      });
  return rows;
}

/**
 * Apply one report's container and service snapshots. The current-state rows (container_items,
 * service_items) are only rewritten when something changed since the last apply (compared with a Redis
 * hash), when something is down (its "stopped for N reports" streak must count), or once a minute.
 */
async function applySnapshots(store, item, states) {
  const { agentId, orgId, receivedAt: now } = item.data;
  const { input, calc } = item;
  const agent = { id: agentId, orgId };
  const reportedAt = new Date(Math.min(new Date(input.sentAt).getTime() + (calc.skewed ? calc.offset : 0), now));
  let metrics = [];
  let applied = false;
  if (input.containers) {
    const sig = containerSig(input.containers);
    const prev = states.c.get(agentId);
    const down = input.containers.some((c) => normalizeContainerState(c.state) === 'stopped');
    const names = new Set(input.containers.map((c) => c.name));
    if (prev && prev.sig === sig && !prev.pending && !down && now - prev.at < REAPPLY_MS && [...names].every((n) => prev.ids[n])) {
      metrics = metricRowsFromIds(agent, input.containers, prev.ids, reportedAt);
    } else {
      const result = await recordContainers(store, agent, input.containers, { reportedAt, now, insertMetrics: false });
      metrics = result.metrics;
      states.c.set(agentId, { sig, at: now, ids: result.ids, pending: result.pending });
      states.dirtyC.add(agentId);
      applied = true;
    }
  }
  if (input.services) {
    const sig = serviceSig(input.services);
    const prev = states.s.get(agentId);
    const down = input.services.some((s) => isDown(s.state));
    if (!(prev && prev.sig === sig && !prev.pending && !down && now - prev.at < REAPPLY_MS)) {
      const result = await recordServices(store, agent, input.services, { reportedAt, now });
      states.s.set(agentId, { sig, at: now, pending: result.pending });
      states.dirtyS.add(agentId);
      applied = true;
    }
  }
  if (applied) await trimStateEvents(store, agentId, now);
  return metrics;
}

async function mapLimit(list, limit, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (next < list.length) await fn(list[next++]);
    }),
  );
}

/** Write one batch of jobs. Every item ends up with `error` set or not; the caller settles the promises. */
async function writeBatch(store, items) {
  const redis = getRedis();
  for (const it of items) {
    it.calc = samplesToRows({ id: it.data.agentId, orgId: it.data.orgId }, it.input, it.data.receivedAt);
  }
  // 1. All samples of the batch in one multi-row insert (re-sent samples are skipped by the primary key).
  await insertSamples(
    store,
    items.flatMap((it) => it.calc.rows),
  );

  // 2. Per server, in order: container/service state; then one insert for all container metric rows.
  const byAgent = new Map();
  for (const it of items) {
    if (!byAgent.has(it.data.agentId)) byAgent.set(it.data.agentId, []);
    byAgent.get(it.data.agentId).push(it);
  }
  const needState = [...byAgent.keys()].filter((id) => byAgent.get(id).some((it) => it.input.containers || it.input.services));
  const states = { c: new Map(), s: new Map(), dirtyC: new Set(), dirtyS: new Set() };
  if (needState.length) {
    const [cs, ss] = await Promise.all([redis.hmget(CSTATE_KEY, ...needState), redis.hmget(SSTATE_KEY, ...needState)]);
    needState.forEach((id, i) => {
      const c = parseHash([cs[i]])[0];
      const s = parseHash([ss[i]])[0];
      if (c) states.c.set(id, c);
      if (s) states.s.set(id, s);
    });
  }
  await mapLimit(needState, 8, async (agentId) => {
    const group = byAgent.get(agentId).sort((a, b) => a.data.receivedAt - b.data.receivedAt);
    for (const it of group) {
      if (!it.input.containers && !it.input.services) continue;
      try {
        it.metrics = await applySnapshots(store, it, states);
      } catch (error) {
        it.error = error;
      }
    }
  });
  const metricRows = items.flatMap((it) => (it.error ? [] : (it.metrics ?? [])));
  for (let i = 0; i < metricRows.length; i += 2000)
    await store.client.containerMetric.createMany({ data: metricRows.slice(i, i + 2000), skipDuplicates: true });

  // 3. Remember what was applied, the live snapshot for the last-seen flush, and queue the side effects.
  const pipeline = redis.pipeline();
  for (const id of states.dirtyC) pipeline.hset(CSTATE_KEY, id, JSON.stringify(states.c.get(id)));
  for (const id of states.dirtyS) pipeline.hset(SSTATE_KEY, id, JSON.stringify(states.s.get(id)));
  const effects = [];
  for (const [agentId, group] of byAgent) {
    const ok = group.filter((it) => !it.error);
    if (!ok.length) continue;
    const latest = ok.reduce((a, b) => (b.data.receivedAt >= a.data.receivedAt ? b : a));
    const agentInfo = latest.input.agent;
    const withData = [...ok].reverse().find((it) => it.calc.newest);
    pipeline.hset(
      LIVE_KEY,
      agentId,
      JSON.stringify({
        v: agentInfo.version,
        os: agentInfo.os,
        arch: agentInfo.arch,
        snap: withData ? liveSnapshot(withData.input, withData.calc.newest) : undefined,
      }),
    );
    const { orgId } = latest.data;
    for (const it of ok) for (const e of it.input.errors) effects.push({ type: 'agent_error', orgId, agentId, code: e.code, message: e.message });
    const skew = ok.find((it) => it.calc.skewed);
    if (skew) effects.push({ type: 'clock_skew', orgId, agentId, offsetMs: skew.calc.offset });
    if (ok.some((it) => it.data.first)) {
      effects.push({ type: 'first_data', orgId, agentId });
      // The server is live now: do not wait for the next last-seen flush to show it.
      await store.client.agent.updateMany({
        where: { id: agentId, status: 'pending' },
        data: {
          status: 'healthy',
          lastSeen: new Date(latest.data.receivedAt),
          version: agentInfo.version,
          os: agentInfo.os,
          arch: agentInfo.arch,
        },
      });
    }
  }
  await pipeline.exec();
  await enqueueSideEffects(effects);
}

async function handleBatch(store, items) {
  try {
    await writeBatch(store, items);
  } catch (error) {
    for (const it of items) it.error ||= error;
  }
  for (const it of items) (it.error ? it.reject(it.error) : it.resolve({ rows: it.calc?.rows.length ?? 0 }));
}

// --------------------------------------------------------------------------------------------- workers

/**
 * Start the ingest-side workers for the given roles ('ingest' or 'all'): the batching ingest consumer,
 * the side-effects consumer and (unless `lastSeen: false`) the 30 s last-seen flush scheduler.
 * `store` is the Prisma store. Returns an async `stop()`; `stop.flush()` forces the pending batch out and
 * `stop.idle()` says whether nothing is buffered.
 */
export function startIngestWorkers({
  store,
  roles = ['all'],
  maxRows = 1000,
  flushMs = 1000,
  concurrency = Number(process.env.INGEST_CONCURRENCY) || 500,
  lastSeen = true,
} = {}) {
  const list = [roles].flat();
  const closers = [];
  const stop = async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  };
  stop.flush = async () => {};
  stop.idle = () => true;
  if (!list.includes('all') && !list.includes('ingest')) return stop;

  const batcher = new Batcher((items) => handleBatch(store, items), { maxRows, maxMs: flushMs });
  const connection = createBullConnection();
  const worker = new Worker(INGEST_QUEUE, (job) => batcher.add(job), {
    connection,
    prefix: BULL_PREFIX,
    concurrency,
  });
  worker.on('error', () => {});
  worker.on('failed', (job, error) => console.error(`[ingest] job ${job?.id} failed: ${error.message}`));
  closers.push(async () => {
    await batcher.flush();
    await worker.close().catch(() => {});
    await connection.quit().catch(() => connection.disconnect());
  });
  closers.push(startSideEffectsWorker(store));

  if (lastSeen) {
    const queue = getQueue(LASTSEEN_QUEUE);
    queue
      .upsertJobScheduler('lastseen-flush', { every: LASTSEEN_FLUSH_EVERY_MS }, { name: 'flush' })
      .catch((error) => console.error('[ingest] could not schedule the last-seen flush:', error.message));
    const flushConnection = createBullConnection();
    const flusher = new Worker(LASTSEEN_QUEUE, () => flushLastSeen(store), {
      connection: flushConnection,
      prefix: BULL_PREFIX,
      concurrency: 1,
    });
    flusher.on('error', () => {});
    flusher.on('failed', (job, error) => console.error(`[lastseen] flush failed: ${error.message}`));
    seedLastSeen(store).catch((error) => console.error('[lastseen] seeding failed:', error.message));
    closers.push(async () => {
      await flusher.close().catch(() => {});
      await flushConnection.quit().catch(() => flushConnection.disconnect());
    });
  }
  stop.flush = () => batcher.flush();
  stop.idle = () => batcher.idle;
  return stop;
}

/**
 * Role definition for services/workers.js: `registerRole('ingest', ingestRole)`. It runs the ingest
 * consumer, the side-effects consumer and the 30 s last-seen flush; `stop` is handled by `onStop`.
 */
export const ingestRole = {
  queues: [INGEST_QUEUE, SIDE_EFFECTS_QUEUE, LASTSEEN_QUEUE],
  async start(store) {
    const stop = startIngestWorkers({ store, roles: ['ingest'] });
    return {
      workers: [],
      onStop: async () => {
        await stop();
        await closeIngestQueues();
      },
    };
  },
};

// ----------------------------------------------------------------------------------------------- tests

let testRuntime = null;
/** Stop the lazily started in-process worker (tests flush Redis underneath it). */
export async function resetIngestRuntime() {
  const current = testRuntime;
  testRuntime = null;
  if (current) await current.stop();
}

const busyCounts = async (queue) => {
  const c = await queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized', 'paused');
  return Object.values(c).reduce((a, b) => a + b, 0);
};

/**
 * Test helper: process everything queued so far (ingest jobs, then their side effects), then flush the
 * last-seen times to Postgres. Starts an in-process worker on first use.
 */
export async function drainIngest(store, { timeoutMs = 20000 } = {}) {
  if (testRuntime && testRuntime.store !== store) await resetIngestRuntime();
  testRuntime ||= {
    store,
    stop: startIngestWorkers({ store, roles: ['ingest'], lastSeen: false, flushMs: 25 }),
  };
  const { stop } = testRuntime;
  const deadline = Date.now() + timeoutMs;
  let quiet = 0;
  while (quiet < 2) {
    if (Date.now() > deadline) throw new Error('drainIngest timed out');
    await stop.flush();
    const waiting = (await busyCounts(ingestQueue())) + (await busyCounts(sideEffectsQueue()));
    quiet = waiting === 0 && stop.idle() ? quiet + 1 : 0;
    await new Promise((r) => setTimeout(r, quiet ? 5 : 15));
  }
  await flushLastSeen(store);
}
