import { api } from '@/lib/api';

// Every call the signed-out pages make. Shapes follow docs/api/account.md and docs/api/team.md.
export const forgotPassword = (email) =>
  api('/auth/forgot-password', { method: 'POST', body: { email } });
export const resetPassword = (token, password) =>
  api('/auth/reset-password', { method: 'POST', body: { token, password } });
export const verifyEmail = (token) =>
  api('/auth/verify-email', { method: 'POST', body: { token } });

/**
 * The invite endpoints put a machine-readable `reason` next to `error` (expired, used, revoked,
 * signin_required, wrong_account). The shared api() drops it, so these two calls keep it.
 */
async function inviteCall(path, options = {}) {
  const response = await fetch(`/api/invites/${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const failure = new Error(data.error || `Request failed (${response.status}).`);
    failure.status = response.status;
    failure.reason = data.reason;
    throw failure;
  }
  return data;
}
export const getInvite = (token) => inviteCall(encodeURIComponent(token));
export const acceptInvite = (token, body = {}) =>
  inviteCall(`${encodeURIComponent(token)}/accept`, { method: 'POST', body: JSON.stringify(body) });
