// All alert and contact API calls live here so a contract change touches one file.
import { useApi, useAction } from '@/lib/hooks';

export const useRules = () => useApi('/alerts/rules');
export const useTemplates = () => useApi('/alerts/templates');
export const useMetrics = () => useApi('/alerts/metrics');
export const useServerList = () => useApi('/servers');
export const useWebsiteList = () => useApi('/websites');
export const useContacts = (options) => useApi('/contacts', {}, options);
export { useAction };

export const createRule = (body) => ({ path: '/alerts/rules', method: 'POST', body, quiet: true });
export const updateRule = (id, body) => ({
  path: `/alerts/rules/${id}`,
  method: 'PATCH',
  body,
  quiet: true,
});
export const deleteRule = (id) => ({ path: `/alerts/rules/${id}`, method: 'DELETE', quiet: true });
export const ruleFromTemplate = (templateKey) => ({
  path: '/alerts/rules/from-template',
  method: 'POST',
  body: { templateKey },
  quiet: true,
});
export const setIncidentState = (id, state) => ({
  path: `/alerts/incidents/${id}`,
  method: 'PATCH',
  body: { state },
  quiet: true,
});
export const createContact = (body) => ({ path: '/contacts', method: 'POST', body, quiet: true });
export const updateContact = (id, body) => ({
  path: `/contacts/${id}`,
  method: 'PATCH',
  body,
  quiet: true,
});
export const deleteContact = (id) => ({ path: `/contacts/${id}`, method: 'DELETE', quiet: true });
export const testContact = (id) => ({ path: `/contacts/${id}/test`, quiet: true });
export const telegramLink = (id) => ({ path: `/contacts/${id}/telegram-link`, quiet: true });
export const rotateSecret = (id) => ({ path: `/contacts/${id}/rotate-secret`, quiet: true });
