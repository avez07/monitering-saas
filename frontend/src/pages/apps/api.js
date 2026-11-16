import { useQuery } from '@tanstack/react-query';
import { api, session } from '@/lib/api';
import { listQuery } from './model';

// Paths per docs/api/apps.md. Repeated `attribute` params are built into the path string.
const qs = (s) => (s ? `?${s}` : '');

export const getServices = (range) => api(`/apps/services${qs(new URLSearchParams({ range }))}`);
export const getService = (name, range) =>
  api(`/apps/services/${encodeURIComponent(name)}${qs(new URLSearchParams({ range }))}`);
export const getTraces = (filters, extra) => api(`/apps/traces${qs(listQuery(filters, extra))}`);
export const getTrace = (id) => api(`/apps/traces/${encodeURIComponent(id)}`);
export const getLogs = (filters, extra) => api(`/apps/logs${qs(listQuery(filters, extra))}`);
export const getConnection = () => api('/apps/connection');
export const getAppSettings = () => api('/apps/settings');
export const saveAppSettings = (body) => api('/apps/settings', { method: 'PUT', body });
export const listTelemetryKeys = () => api('/telemetry-keys');
export const createTelemetryKey = (name) =>
  api('/telemetry-keys', { method: 'POST', body: { name } });
export const revokeTelemetryKey = (id) =>
  api(`/telemetry-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });

/** Query keys include the organization so switching organizations never shows stale rows. */
export const useCall = (key, fn, options = {}) =>
  useQuery({ queryKey: [session.org, 'apps', ...key], queryFn: fn, retry: false, ...options });

export const RANGES = [
  { value: '15m', label: 'Last 15 minutes' },
  { value: '1h', label: 'Last hour' },
  { value: '6h', label: 'Last 6 hours' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '3d', label: 'Last 3 days' },
  { value: '7d', label: 'Last 7 days' },
  { value: '15d', label: 'Last 15 days' },
  { value: '30d', label: 'Last 30 days' },
];
