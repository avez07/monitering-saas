import { useEffect, useRef } from 'react';
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { ErrorState, LoadingState, PageHeader, StatusBadge } from '@/components/app';
import { cn } from '@/lib/utils';
import { useConnection, useServer } from './api';
import { serverStatus, statusLabel } from './status';
import OverviewTab from './OverviewTab';
import ConnectionTab from './ConnectionTab';
import SettingsTab from './SettingsTab';

const tabClass = ({ isActive }) =>
  cn(
    'inline-flex items-center whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    isActive
      ? 'bg-primary text-primary-foreground'
      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
  );

export default function ServerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { data: server, error, isLoading, refetch } = useServer(id);
  const connection = useConnection(id);
  const redirected = useRef(false);

  // A server that is not healthy yet opens on its Connection tab (once), as the plan says.
  const unhealthy = server && server.status !== 'online';
  const atRoot = location.pathname.replace(/\/$/, '') === `/servers/${id}`;
  useEffect(() => {
    if (unhealthy && atRoot && !redirected.current) {
      redirected.current = true;
      navigate(`/servers/${id}/connection`, { replace: true });
    }
    if (server && !unhealthy) redirected.current = true;
  }, [unhealthy, atRoot, server, id, navigate]);

  if (isLoading) return <LoadingState label="Loading server…" />;
  if (error?.status === 404)
    return (
      <ErrorState
        title="We can't find that server"
        error="It may have been removed."
        onRetry={() => navigate('/servers')}
      />
    );
  if (error)
    return <ErrorState title="We couldn't load this server" error={error} onRetry={refetch} />;

  const problems = connection.data?.problems?.length ?? 0;
  return (
    <>
      <PageHeader
        title={server.name}
        description={[server.os, server.hostname !== server.name && server.hostname]
          .filter(Boolean)
          .join(' · ')}
        breadcrumbs={[{ label: 'Servers', to: '/servers' }, { label: server.name }]}
        actions={<StatusBadge status={serverStatus(server)} label={statusLabel(server)} />}
      />
      <nav aria-label="Server sections" className="-mt-2 mb-6 flex gap-1 overflow-x-auto pb-1">
        <NavLink to={`/servers/${id}`} end className={tabClass}>
          Overview
        </NavLink>
        <NavLink to={`/servers/${id}/connection`} className={tabClass}>
          Connection
          {problems > 0 && (
            <span className="ml-2 rounded-full bg-destructive px-1.5 text-xs text-destructive-foreground">
              {problems}
              <span className="sr-only"> problems</span>
            </span>
          )}
        </NavLink>
        <NavLink to={`/servers/${id}/settings`} className={tabClass}>
          Settings
        </NavLink>
      </nav>
      <Routes>
        <Route index element={<OverviewTab server={server} />} />
        <Route
          path="connection"
          element={<ConnectionTab server={server} connection={connection} />}
        />
        <Route
          path="settings"
          element={<SettingsTab server={server} commands={connection.data?.commands} />}
        />
        <Route path="*" element={<Navigate to={`/servers/${id}`} replace />} />
      </Routes>
    </>
  );
}
