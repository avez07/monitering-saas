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
  const who = event.agentId
    ? { agentId: event.agentId }
    : { agentId: null, fingerprint: event.fingerprint ?? null };
  const recent = await store.client.agentEvent.findFirst({
    where: {
      orgId: event.orgId,
      code: event.code,
      source: event.source,
      createdAt: { gt: new Date(Date.now() - windowMs) },
      ...who,
    },
    select: { id: true },
  });
  if (recent) return null;
  const row = await recordEvent(store, event);
  if (event.agentId) await trimEvents(store, event.agentId);
  return row;
}
