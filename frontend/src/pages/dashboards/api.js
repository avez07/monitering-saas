// Dashboard API calls. Contract: docs/api/advanced-telemetry.md section 4.
import { api } from '@/lib/api';
import { useApi } from '@/lib/hooks';

/** Never retry "not entitled" (402) or bad queries; back off once on rate limits. */
export const retryPolicy = (count, error) =>
  error?.status === 429 ? count < 2 : ![400, 402, 403, 404, 422].includes(error?.status) && count < 1;
export const retryDelay = (count, error) => (error?.status === 429 ? 10000 * (count + 1) : 1000);

const opts = { retry: retryPolicy, retryDelay, staleTime: 5 * 60000 };

export const usePresets = (enabled = true) => useApi('/dashboards/presets', {}, { ...opts, enabled });
export const usePreset = (id, enabled = true) => useApi(`/dashboards/presets/${id}`, {}, { ...opts, enabled });
export const useTargets = (enabled = true) =>
  useApi('/dashboards/targets', {}, { ...opts, staleTime: 30000, refetchInterval: 60000, enabled });

/** Range query → Prometheus `data.result` (matrix). */
export async function queryRange({ query, start, end, step }) {
  const res = await api('/dashboards/query_range', { params: { query, start, end, step } });
  return res?.data?.result ?? [];
}

/** Instant query → Prometheus `data.result` (vector). */
export async function queryInstant({ query, time }) {
  const res = await api('/dashboards/query', { params: { query, time } });
  return res?.data?.result ?? [];
}

export const listOf = (data) => (Array.isArray(data) ? data : (data?.items ?? []));
