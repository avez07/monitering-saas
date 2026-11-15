import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, session as orgStore } from '@/lib/api';

// Every call the settings pages make (paths per docs/api/team.md, account.md and api-key.js).
export const listMembers = () => api('/members');
export const listInvites = () => api('/invites');
export const inviteMember = (body) => api('/invites', { method: 'POST', body });
export const resendInvite = (id) => api(`/invites/${id}/resend`, { method: 'POST' });
export const cancelInvite = (id) => api(`/invites/${id}`, { method: 'DELETE' });
export const changeRole = (id, role) => api(`/members/${id}`, { method: 'PATCH', body: { role } });
export const removeMember = (id) => api(`/members/${id}`, { method: 'DELETE' });

export const getApiKey = () => api('/api-key');
export const regenerateApiKey = () => api('/api-key/regenerate', { method: 'POST' });
export const createApiKey = () => api('/api-key', { method: 'POST' });
export const revokeApiKey = (disconnectServers) =>
  api('/api-key', { method: 'DELETE', params: { disconnectServers: String(!!disconnectServers) } });

export const getOrgSettings = () => api('/settings');
export const renameOrg = (name) => api('/settings', { method: 'PATCH', body: { name } });
export const logoutAll = () => api('/auth/logout-all', { method: 'POST' });
export const resendVerification = () => api('/auth/resend-verification', { method: 'POST' });
export const requestPasswordReset = (email) =>
  api('/auth/forgot-password', { method: 'POST', body: { email } });

/** Run one of the calls above, refresh every query afterwards and toast failures. */
export function useDo(fn, { success, quiet } = {}) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      client.invalidateQueries();
      const text = typeof success === 'function' ? success(data) : success;
      if (text) toast.success(text);
    },
    onError: (error) => !quiet && toast.error(error.message),
  });
}

/** Query keys include the organization so switching organizations never shows stale rows. */
export const useCall = (key, fn, options = {}) =>
  useQuery({ queryKey: [orgStore.org, ...key], queryFn: fn, retry: false, ...options });
