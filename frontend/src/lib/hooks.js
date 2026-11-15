import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, session } from './api';

/** GET helper. The query key includes the organization so switching orgs never shows stale data. */
export function useApi(path, params = {}, options = {}) {
  return useQuery({
    queryKey: [session.org, path, params],
    queryFn: () => api(path, { params }),
    ...options,
  });
}

/**
 * Change something through the API. Afterwards every query refreshes. The API's own `message`
 * is shown as a toast unless `quiet: true`; failures always show an error toast.
 * Usage: const action = useAction(); action.mutate({ path, method, body, quiet })
 */
export function useAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ path, method = 'POST', body }) => api(path, { method, body }),
    onSuccess: (data, { quiet }) => {
      client.invalidateQueries();
      if (data?.message && !quiet) toast.success(data.message);
    },
    onError: (error) => toast.error(error.message),
  });
}
