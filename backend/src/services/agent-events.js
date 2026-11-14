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
