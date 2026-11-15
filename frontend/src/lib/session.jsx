import { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, session as orgStore } from './api';

const SessionContext = createContext(null);

// Drop all cached data except the sign-in check (clearing that would detach its observer).
const forget = (client) =>
  client.removeQueries({
    predicate: (q) => q.queryKey[0] !== 'session' || q.queryKey[1] === 'bootstrap',
  });

/**
 * Session bootstrap: /api/auth/me says whether the httpOnly cookie is valid, then
 * /api/bootstrap returns user, organizations, role and plan. Read it with useSession().
 */
export function SessionProvider({ children }) {
  const client = useQueryClient();
  const me = useQuery({
    queryKey: ['session', 'me'],
    queryFn: () =>
      api('/auth/me').then(
        () => true,
        () => false,
      ),
    staleTime: Infinity,
  });
  const signedIn = me.data === true;
  const boot = useQuery({
    queryKey: ['session', 'bootstrap', orgStore.org],
    queryFn: () => api('/bootstrap'),
    enabled: signedIn,
    staleTime: 60000,
  });

  const signOut = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    orgStore.org = null;
    forget(client);
    client.setQueryData(['session', 'me'], false);
  }, [client]);

  const signedInNow = useCallback(() => {
    orgStore.org = null;
    forget(client);
    client.setQueryData(['session', 'me'], true);
  }, [client]);

  const switchOrganization = useCallback(
    (id) => {
      orgStore.org = id;
      forget(client);
      client.setQueryData(['session', 'me'], true);
    },
    [client],
  );

  useEffect(() => {
    window.addEventListener('yuktiops:logout', signOut);
    return () => window.removeEventListener('yuktiops:logout', signOut);
  }, [signOut]);

  const data = boot.data;
  const value = useMemo(
    () => ({
      status: me.isPending ? 'checking' : signedIn ? 'in' : 'out',
      ready: signedIn && !!data,
      bootError: boot.error,
      user: data?.user ?? null,
      organization: data?.organization ?? null,
      organizations: data?.organizations ?? [],
      role: data?.role ?? null,
      plan: data?.plan ?? null,
      subscription: data?.subscription ?? null,
      apiPublicUrl: data?.apiPublicUrl ?? '',
      canEdit: ['owner', 'admin', 'editor'].includes(data?.role),
      isAdmin: ['owner', 'admin'].includes(data?.role),
      signOut,
      signedIn: signedInNow,
      switchOrganization,
    }),
    [me.isPending, signedIn, data, boot.error, signOut, signedInNow, switchOrganization],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);
