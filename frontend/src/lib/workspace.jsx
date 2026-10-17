import { createContext, useContext } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, session } from './api';
export const WorkspaceContext = createContext(null);
export const useWorkspace = () => useContext(WorkspaceContext);
export function useApi(path, params = {}, options = {}) {
  return useQuery({
    queryKey: [session.org, path, params],
    queryFn: () => api(path, { params }),
    ...options,
  });
}
export function useAction() {
  const client = useQueryClient();
  const workspace = useWorkspace();
  return useMutation({
    mutationFn: ({ path, method = 'POST', body }) => api(path, { method, body }),
    onSuccess: (data) => {
      client.invalidateQueries();
      if (data?.message) workspace?.notify(data.message);
    },
    onError: (error) => workspace?.notify(error.message, 'error'),
  });
}
export const formatNumber = (value, decimals = 0) =>
  Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: decimals });
export const formatDate = (value) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
export function relativeTime(value) {
  if (!value) return 'Waiting for data';
  const minutes = Math.floor((Date.now() - new Date(value)) / 60000);
  return minutes < 1
    ? 'Just now'
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`;
}
