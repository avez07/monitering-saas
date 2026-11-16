import { getRedis } from '../lib/redis.js';

export const MAX_EVENTS_PER_AGENT = 50;

/** Record something the connection page should be able to show (install step, agent error, ...). */
export function recordEvent(store, event) {
  return store.create('agentEvent', {
    agentId: null,
    fingerprint: null,
    message: '',
    details: {},
    ...event,
  });
}

/** Keep only the newest events for one agent. */
export async function trimEvents(store, agentId, keep = MAX_EVENTS_PER_AGENT) {
  // Select by id rather than by timestamp: events written in the same millisecond share a createdAt.
  const stale = await store.client.agentEvent.findMany({
    where: { agentId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: keep,
    select: { id: true },
  });
  if (!stale.length) return 0;
  return store.removeMany('agentEvent', { id: { in: stale.map((e) => e.id) } });
}

export const DEDUPE_MS = 5 * 60000;

/**
 * Record an event unless the same code was already recorded for the same server (or, before it has
 * one, the same install fingerprint) in the last few minutes, so a flapping agent cannot flood the log.
 */
export async function recordDeduped(store, event, windowMs = DEDUPE_MS) {
  // One Redis SET NX per (server or fingerprint, source, code) replaces a findFirst on every report.
  const who = event.agentId ? `a:${event.agentId}` : `f:${event.fingerprint ?? ''}`;
  const key = `dedupe:${event.orgId}:${who}:${event.source}:${event.code}`;
  const redis = getRedis();
  const acquired = await redis.set(key, '1', 'PX', windowMs, 'NX');
  if (!acquired) return null;
  try {
    const row = await recordEvent(store, event);
    if (event.agentId) await trimEvents(store, event.agentId);
    return row;
  } catch (error) {
    await redis.del(key).catch(() => {}); // nothing was recorded, so let the next report try again
    throw error;
  }
}
