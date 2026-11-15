import { api } from '@/lib/api';

// Every call the Add-server wizard makes. If a backend shape changes, change it here only.

/** The account API key (null when none). Admin only. */
export const getApiKey = () => api('/api-key').then((r) => r.key);
export const createApiKey = () => api('/api-key', { method: 'POST' }); // { prefix, key, ... }
export const regenerateApiKey = () => api('/api-key/regenerate', { method: 'POST' });

/** Save the setup profile; returns { id: 'st_...' }. Updates when `id` is given. */
export const saveProfile = ({ id, name, settings }) =>
  id
    ? api(`/agent-configs/${id}`, { method: 'PUT', body: { settings } })
    : api('/agent-configs', { method: 'POST', body: { name, settings } });

/**
 * What can be downloaded. Expected shape (docs/api/agent-releases.md):
 * { version, channel, installScriptUrl, install: { commandTemplate, uninstallCommand },
 *   files: [{ name, arch, archLabel, kind, distro, url, sha256 }], docker: { image, tag, run } }
 * Resolves to null when the endpoint is missing, so the wizard falls back to the one-command tab.
 */
export const getReleases = () => api('/agent/releases').catch(() => null);

/** Install progress before any server exists, and after one registered. */
export const getPending = (since) => api('/connection/pending', { params: { since } });
export const getConnection = (id) => api(`/servers/${id}/connection`);
