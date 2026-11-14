import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { api, session } from './lib/api';
import { Layout } from './components/Layout';
import { Loading } from './components/ui';
import { AuthPage } from './pages/Auth';
import { Overview } from './pages/Overview';
import { ServersPage } from './pages/Resources';
import { AlertsPage, AgentsPage, UptimePage } from './pages/Operations';
import { TeamPage, BillingPage, SettingsPage } from './pages/Administration';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15000, retry: 1, refetchOnWindowFocus: false } },
});
function App() {
  // 'checking' until the server tells us whether the httpOnly session cookie is valid.
  const [state, setState] = useState('checking');
  useEffect(() => {
    api('/auth/me')
      .then(() => setState('in'))
      .catch(() => setState('out'));
  }, []);
  useEffect(() => {
    const logout = () => {
      // Revoke the session on the server first; the cookie itself is cleared by the response.
      api('/auth/logout', { method: 'POST' })
        .catch(() => {})
        .finally(() => {
          session.org = null;
          queryClient.clear();
          setState('out');
        });
    };
    window.addEventListener('yuktiops:logout', logout);
    return () => window.removeEventListener('yuktiops:logout', logout);
  }, []);
  if (state === 'checking') return <Loading />;
  if (state === 'out')
    return (
      <AuthPage
        onSuccess={() => {
          queryClient.clear();
          setState('in');
        }}
      />
    );
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Overview />} />
          <Route path="servers" element={<ServersPage />} />
          <Route path="uptime" element={<UptimePage />} />
          <Route path="alerts" element={<AlertsPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="team" element={<TeamPage />} />
          <Route path="billing" element={<BillingPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
