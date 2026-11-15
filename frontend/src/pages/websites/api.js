// All website API calls live here so a contract change touches one file.
import { useApi, useAction } from '@/lib/hooks';

export const useWebsites = (options) => useApi('/websites', {}, options);
export const useWebsite = (id, options) => useApi(`/websites/${id}`, {}, options);
export const useChecks = (id, range, options) =>
  useApi(`/websites/${id}/checks`, { range }, options);
export const useWebsiteIncidents = (id) =>
  useApi('/alerts/incidents', { resourceId: id, limit: 10 });
export { useAction };

export const createWebsite = (body) => ({ path: '/websites', method: 'POST', body, quiet: true });
export const updateWebsite = (id, body) => ({
  path: `/websites/${id}`,
  method: 'PATCH',
  body,
  quiet: true,
});
export const deleteWebsite = (id) => ({ path: `/websites/${id}`, method: 'DELETE', quiet: true });
export const pauseWebsite = (id) => ({ path: `/websites/${id}/pause`, quiet: true });
export const resumeWebsite = (id) => ({ path: `/websites/${id}/resume`, quiet: true });
export const checkWebsite = (id) => ({ path: `/websites/${id}/check`, quiet: true });

export const INTERVALS = [
  { seconds: 30, label: 'every 30 seconds' },
  { seconds: 60, label: 'every minute' },
  { seconds: 300, label: 'every 5 minutes' },
  { seconds: 600, label: 'every 10 minutes' },
  { seconds: 900, label: 'every 15 minutes' },
  { seconds: 1800, label: 'every 30 minutes' },
  { seconds: 3600, label: 'every hour' },
];

export const TYPE_LABELS = {
  http: 'Web page',
  keyword: 'Page with a word',
  api: 'API check',
  tcp: 'Port (TCP)',
};

/** Status word and shared-status key for a monitor. */
export function siteStatus(site) {
  if (site.status === 'paused') return { status: 'unknown', label: 'Paused' };
  if (site.status === 'pending') return { status: 'unknown', label: 'Waiting for first check' };
  if (site.status === 'down') return { status: 'unhealthy', label: 'Down' };
  if (site.retrying) return { status: 'warning', label: 'Checking again' };
  return { status: 'healthy', label: 'Up' };
}

/** "x days left" with a word for each band; never colour alone. */
export function expiry(info) {
  if (!info) return { text: 'Not available', status: 'unknown' };
  const d = info.daysLeft;
  if (d === null || d === undefined) return { text: 'Not available', status: 'unknown' };
  if (d < 0 || info.warning === 0) return { text: 'Expired', status: 'unhealthy' };
  const text = `${d} day${d === 1 ? '' : 's'} left`;
  return { text, status: d <= 14 ? 'unhealthy' : d <= 30 ? 'warning' : 'healthy' };
}
