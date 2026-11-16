import { z } from 'zod';
import { SEVERITY_LEVELS, SEVERITY_MIN_NUMBER } from './otel-transform.js';

export const samplingSchema = z.object({
  tracesRatio: z.number().min(0).max(1).default(1),
  keepErrors: z.boolean().default(true),
  keepSlowMs: z.number().min(1).max(3600000).nullable().default(null),
  logsMinSeverity: z.enum(SEVERITY_LEVELS).default('trace'),
});
export const DEFAULT_SAMPLING = samplingSchema.parse({});

/** Stored sampling JSON (possibly partial or from an older version) -> a complete settings object. */
export const normalizeSampling = (value) => {
  const parsed = samplingSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : DEFAULT_SAMPLING;
};

/** Deterministic 0..1 value from a trace id (its low 32 bits), the same on every worker. */
const unit = (traceId) => parseInt(traceId.slice(-8), 16) / 0x100000000;

/**
 * Decide per trace (within one batch) and keep or drop all of its spans together. Errors and slow spans
 * rescue a trace regardless of the ratio.
 */
export function sampleSpans(rows, sampling) {
  if (sampling.tracesRatio >= 1) return rows;
  const keepTrace = new Map(); // traceId -> bool
  for (const row of rows) {
    let keep = keepTrace.get(row.TraceId) ?? unit(row.TraceId) < sampling.tracesRatio;
    if (!keep && sampling.keepErrors && row.StatusCode === 'Error') keep = true;
    if (!keep && sampling.keepSlowMs != null && row.Duration >= sampling.keepSlowMs * 1e6) keep = true;
    keepTrace.set(row.TraceId, keep);
  }
  return rows.filter((row) => keepTrace.get(row.TraceId));
}

/** Drop log records below the minimum severity (records with no severity always pass). */
export function sampleLogs(rows, sampling) {
  const min = SEVERITY_MIN_NUMBER[sampling.logsMinSeverity] ?? 1;
  if (min <= 1) return rows;
  return rows.filter((row) => row.SeverityNumber === 0 || row.SeverityNumber >= min);
}
