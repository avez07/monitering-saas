const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Turn one agent sample into a `server_metrics` row. */
export function sampleToRow(orgId, agentId, sample, time) {
  return {
    time,
    agentId,
    orgId,
    cpuPercent: num(sample.cpu),
    memPercent: num(sample.memory),
    swapPercent: num(sample.swap),
    diskPercent: num(sample.disk),
    load1: num(sample.load?.[0]),
    load5: num(sample.load?.[1]),
    load15: num(sample.load?.[2]),
    netRxBps: num(sample.netRxBps),
    netTxBps: num(sample.netTxBps),
    diskReadBps: num(sample.diskReadBps),
    diskWriteBps: num(sample.diskWriteBps),
    uptimeSeconds: num(sample.uptimeSeconds),
    ...(sample.details ? { details: sample.details } : {}),
  };
}

/** Store samples. A re-sent batch (same agent and timestamp) is ignored, so retries are harmless. */
export async function insertSamples(store, rows) {
  if (!rows.length) return 0;
  return (await store.client.serverMetric.createMany({ data: rows, skipDuplicates: true })).count;
}

/** The oldest moment a plan's history may be read from (Phase 7 charts clamp their range to this). */
export const retentionCutoff = (plan, now = Date.now()) =>
  new Date(now - plan.retentionDays * 86400000);

/**
 * Raw samples are kept for 8 days by a Timescale policy. Plans with a shorter history (Free: 7 days)
 * get their older raw rows removed here. Rollup data is limited when it is read.
 */
export async function trimRawMetricsByPlan(store) {
  return store.client.$executeRaw`
    DELETE FROM server_metrics m
    USING "Subscription" s JOIN "SubscriptionPlan" p ON p."id" = s."planId"
    WHERE s."orgId" = m.org_id
      AND p."retentionDays" < 8
      AND m."time" < now() - make_interval(days => p."retentionDays")`;
}
