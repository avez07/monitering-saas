// All server API calls live here so a changed response shape is a one-file fix.
import { useApi } from '@/lib/hooks';

export const RANGES = [
  { key: '1h', label: '1 hour' },
  { key: '24h', label: '24 hours' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
];

/** Servers list. Refreshes every 30 s. `servers` is always an array. */
export function useServers() {
  const query = useApi('/servers', {}, { refetchInterval: 30000 });
  const data = query.data;
  return { ...query, servers: Array.isArray(data) ? data : (data?.items ?? []) };
}

export const useServer = (id) =>
  useApi(
    `/servers/${id}`,
    {},
    { refetchInterval: 30000, retry: (count, error) => error.status !== 404 && count < 2 },
  );

export const useServerMetrics = (id, range) =>
  useApi(`/servers/${id}/metrics`, { range }, { refetchInterval: 60000 });

/** Connection checklist. Refreshes every 5 s until the server is connected, then every 30 s. */
export const useConnection = (id) =>
  useApi(
    `/servers/${id}/connection`,
    {},
    { refetchInterval: (query) => (query.state.data?.overall === 'connected' ? 30000 : 5000) },
  );
