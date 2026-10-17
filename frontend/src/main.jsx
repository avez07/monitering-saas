import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { session } from './lib/api';
import { Layout } from './components/Layout';
import { AuthPage } from './pages/Auth';
import { Overview } from './pages/Overview';
import { ResourcePage } from './pages/Resources';
import { LogsPage, TracesPage } from './pages/Explorers';
import { AlertsPage, AgentsPage, UptimePage } from './pages/Operations';
import { TeamPage, BillingPage, SettingsPage } from './pages/Administration';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15000, retry: 1, refetchOnWindowFocus: false } },
});
function App() {
  const [signedIn, setSignedIn] = useState(!!session.token);
  useEffect(() => {
    const logout = () => {
      session.token = null;
      session.org = null;
      queryClient.clear();
      setSignedIn(false);
    };
    window.addEventListener('pulse:logout', logout);
    return () => window.removeEventListener('pulse:logout', logout);
  }, []);
  if (!signedIn)
    return (
      <AuthPage
        onSuccess={() => {
          queryClient.clear();
          setSignedIn(true);
        }}
      />
    );
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Overview />} />
          <Route path="infrastructure" element={<ResourcePage />} />
          <Route path="servers" element={<ResourcePage type="server" />} />
          <Route path="containers" element={<ResourcePage type="container" />} />
          <Route path="applications" element={<ResourcePage type="application" />} />
          <Route path="databases" element={<ResourcePage type="database" />} />
          <Route path="logs" element={<LogsPage />} />
          <Route path="traces" element={<TracesPage />} />
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
