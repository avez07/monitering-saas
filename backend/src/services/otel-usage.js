import { getRedis } from '../lib/redis.js';
import { sendMail } from './mail.js';
import { config } from '../config.js';

const GB = 1024 ** 3;
/** Telemetry volume per calendar month (UTC), counted as uncompressed OTLP request bytes. */
export const PLAN_QUOTA_BYTES = { free: 1 * GB, starter: 10 * GB, pro: 50 * GB, business: 250 * GB };
/** Days a span or log record is kept, by plan. */
export const PLAN_RETENTION_DAYS = { free: 3, starter: 7, pro: 15, business: 30 };

let quotaOverride = null;
/** Tests (and emergency tuning) can force one quota for every plan; pass null to go back to the plan table. */
export const setQuotaOverride = (bytes) => void (quotaOverride = bytes);
export const quotaBytes = (planId) => quotaOverride ?? PLAN_QUOTA_BYTES[planId] ?? PLAN_QUOTA_BYTES.free;
export const retentionDays = (planId) => PLAN_RETENTION_DAYS[planId] ?? PLAN_RETENTION_DAYS.free;

const pad = (n) => String(n).padStart(2, '0');
export const monthKey = (now = Date.now()) => {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
};
export const monthEnd = (now = Date.now()) => {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
};
const usageKey = (orgId, now) => `otel:usage:${orgId}:${monthKey(now)}`;
const SIGNAL_TTL = 70 * 86400;

/** Bytes used this month, in total and by signal. */
export async function readUsage(orgId, now = Date.now()) {
  const redis = getRedis();
  const key = usageKey(orgId, now);
  const [total, bySignal] = await Promise.all([redis.get(key), redis.hgetall(`${key}:sig`)]);
  return {
    month: monthKey(now),
    bytes: Number(total) || 0,
    bySignal: { traces: Number(bySignal.traces) || 0, logs: Number(bySignal.logs) || 0, metrics: Number(bySignal.metrics) || 0 },
    resetsAt: monthEnd(now).toISOString(),
  };
}

/** `{ over: false }` or `{ over: true, retryAfter }` (seconds until the month rolls over). */
export async function checkQuota(orgId, planId, now = Date.now()) {
  const used = Number(await getRedis().get(usageKey(orgId, now))) || 0;
  if (used < quotaBytes(planId)) return { over: false };
  return { over: true, retryAfter: Math.max(1, Math.ceil((monthEnd(now).getTime() - now) / 1000)) };
}

/**
 * Count accepted bytes. When this request moves the month across 80% or 100% of the quota, the owner is
 * emailed once (a Redis flag per month and threshold). `store` finds the owner.
 */
export async function addUsage(store, orgId, planId, bytes, signal, now = Date.now()) {
  const redis = getRedis();
  const key = usageKey(orgId, now);
  const [after] = (
    await redis.multi().incrby(key, bytes).expire(key, SIGNAL_TTL).hincrby(`${key}:sig`, signal, bytes).expire(`${key}:sig`, SIGNAL_TTL).exec()
  ).map(([, v]) => v);
  const limit = quotaBytes(planId);
  const before = after - bytes;
  for (const level of [80, 100]) {
    const mark = (limit * level) / 100;
    if (before < mark && after >= mark && (await redis.set(`${key}:mail:${level}`, '1', 'EX', SIGNAL_TTL, 'NX'))) {
      notifyOwner(store, orgId, planId, level, after, limit).catch((error) =>
        console.error('otel usage mail failed:', error.message),
      );
    }
  }
  return after;
}

async function notifyOwner(store, orgId, planId, level, used, limit) {
  const owner = await store.find('organizationMember', { orgId, role: 'owner' });
  const user = owner && (await store.find('user', { id: owner.userId }));
  if (!user?.email) return;
  const plan = await store.find('subscriptionPlan', { id: planId });
  const gb = (n) => `${Math.round((n / GB) * 100) / 100} GB`;
  await sendMail({
    to: user.email,
    subject:
      level >= 100
        ? 'YuktiOps: your monthly telemetry volume is used up'
        : `YuktiOps: you have used ${level}% of your monthly telemetry volume`,
    text: [
      `Your ${plan?.name ?? planId} plan includes ${gb(limit)} of traces and logs per month. You have used ${gb(used)}.`,
      '',
      level >= 100
        ? 'New telemetry is being refused (HTTP 429) until the month ends or you upgrade. Your apps keep running; exporters retry and then drop data.'
        : 'When it reaches 100%, new telemetry is refused until the month ends or you upgrade.',
      '',
      `Review usage or upgrade: ${config.APP_URL.replace(/\/$/, '')}/billing`,
    ].join('\n'),
  });
}
