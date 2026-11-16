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

export const BACKFILL_WINDOW_MS = 30 * 60000; // samples buffered through an outage may be up to 30 minutes old
export const FUTURE_TOLERANCE_MS = 60000;
export const CLOCK_SKEW_MS = 120000; // beyond this, treat the agent's clock as wrong and correct its timestamps

/**
 * Turn one accepted ingest request into metric rows. `now` is when the API received it (not when a
 * worker got to it). A wrong clock on the server must not lose its data: timestamps are shifted by the
 * measured offset. Samples outside the backfill window are dropped.
 */
export function samplesToRows(agent, input, now) {
  const offset = now - new Date(input.sentAt).getTime();
  const skewed = Math.abs(offset) > CLOCK_SKEW_MS;
  const rows = [];
  let newest = null;
  let dropped = 0;
  for (const s of input.samples) {
    const time = new Date(new Date(s.time).getTime() + (skewed ? offset : 0));
    if (time.getTime() < now - BACKFILL_WINDOW_MS || time.getTime() > now + FUTURE_TOLERANCE_MS) {
      dropped++;
      continue;
    }
    const row = sampleToRow(agent.orgId, agent.id, s, time);
    rows.push(row);
    if (!newest || row.time > newest.row.time) newest = { row, sample: s };
  }
  return { rows, dropped, skewed, offset, newest: newest?.sample ?? null };
}

/** The live values shown on a server's card: taken from its newest sample and the agent's own info. */
export function liveSnapshot(input, sample) {
  if (!sample) return {};
  return Object.fromEntries(
    Object.entries({
      cpu: sample.cpu,
      memory: sample.memory,
      disk: sample.disk,
      uptimeSeconds: sample.uptimeSeconds,
      cores: input.agent.cores,
      ramGb: input.agent.ramBytes ? +(input.agent.ramBytes / 1024 ** 3).toFixed(2) : undefined,
      os: input.agent.os || undefined,
    }).filter(([, v]) => v !== undefined),
  );
}

/** Store samples. A re-sent batch (same agent and timestamp) is ignored, so retries are harmless. */
export async function insertSamples(store, rows) {
  let count = 0;
  for (let i = 0; i < rows.length; i += 2000)
    count += (
      await store.client.serverMetric.createMany({ data: rows.slice(i, i + 2000), skipDuplicates: true })
    ).count;
  return count;
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
