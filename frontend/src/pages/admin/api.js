import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';

/** GET /api/platform/<path>. Keeps the previous page on screen while the next one loads. */
export function usePlatform(path, params = {}, options = {}) {
  return useQuery({
    queryKey: ['platform', path, params],
    queryFn: () => api(`/platform${path}`, { params }),
    placeholderData: keepPreviousData,
    ...options,
  });
}

/** POST to /api/platform/<path>; every query refreshes afterwards and the API's message is toasted. */
export function usePlatformAction() {
  const action = useAction();
  return {
    ...action,
    run: (path, body = {}) =>
      action.mutateAsync({ path: `/platform${path}`, method: 'POST', body }),
  };
}
