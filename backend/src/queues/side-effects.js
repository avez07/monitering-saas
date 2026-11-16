import { Worker } from 'bullmq';
import { createBullConnection, getRedis } from '../lib/redis.js';
import { recordDeduped, recordEvent, trimEvents } from '../services/agent-events.js';
import { BULL_PREFIX, SIDE_EFFECTS_QUEUE, sideEffectsQueue } from './ingest-queues.js';

/**
 * Things an accepted report causes besides storing metrics: connection-page events (first data, clock
 * skew, errors the agent reports). They run here, off the ingest path. Jobs are idempotent: every event
 * is guarded by a Redis dedupe key (see recordDeduped), so a retried job records nothing twice.
 */
export const SKEW_EVENT_EVERY_MS = 10 * 60000;
const FIRST_DATA_KEY_SECONDS = 30 * 86400;

/** Queue several side effects at once. Each is `{ type, orgId, agentId, ... }`. */
export async function enqueueSideEffects(effects) {
  if (!effects.length) return;
  await sideEffectsQueue().addBulk(effects.map((data) => ({ name: data.type, data })));
}

export async function processSideEffect(store, { type, orgId, agentId, ...data }) {
  switch (type) {
    case 'agent_error':
      // Agents repeat the same error on every send; keep one event per code every few minutes.
      return recordDeduped(store, {
        orgId,
        agentId,
        source: 'agent',
        code: data.code,
        message: data.message,
      });
    case 'clock_skew': {
      const seconds = Math.round(Math.abs(data.offsetMs) / 1000);
      return recordDeduped(
        store,
        {
          orgId,
          agentId,
          source: 'server',
          code: 'clock_skew',
          message: `The server clock is about ${seconds} seconds ${data.offsetMs > 0 ? 'behind' : 'ahead of'} real time.`,
          details: { offsetSeconds: Math.round(data.offsetMs / 1000) },
        },
        SKEW_EVENT_EVERY_MS,
      );
    }
    case 'first_data': {
      // The API only sees a stale "pending" status for a while, so many reports can ask for this.
      const acquired = await getRedis().set(`firstdata:${agentId}`, '1', 'EX', FIRST_DATA_KEY_SECONDS, 'NX');
      if (!acquired) return null;
      const seen = await store.client.agentEvent.findFirst({
        where: { agentId, code: 'first_data' },
        select: { id: true },
      });
      if (seen) return null;
      const row = await recordEvent(store, {
        orgId,
        agentId,
        source: 'server',
        code: 'first_data',
        message: 'First data received.',
      });
      await trimEvents(store, agentId);
      return row;
    }
    default:
      throw new Error(`Unknown side effect: ${type}`);
  }
}

/** Start the consumer. Returns an async close function. */
export function startSideEffectsWorker(store, { concurrency = 10 } = {}) {
  const connection = createBullConnection();
  const worker = new Worker(SIDE_EFFECTS_QUEUE, (job) => processSideEffect(store, job.data), {
    connection,
    prefix: BULL_PREFIX,
    concurrency,
  });
  worker.on('error', () => {});
  worker.on('failed', (job, error) =>
    console.error(`[side-effects] ${job?.name} failed: ${error.message}`),
  );
  return async () => {
    await worker.close().catch(() => {});
    await connection.quit().catch(() => connection.disconnect());
  };
}
