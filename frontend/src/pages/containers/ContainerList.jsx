import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Box, Plus, Search } from 'lucide-react';
import {
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  RelativeTime,
  StatusBadge,
  TableSkeleton,
} from '@/components/app';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import MonitorDockerDialog from './MonitorDockerDialog';
import { useApi } from '@/lib/hooks';
import { formatBytes, formatPercent } from '@/lib/format';

// Contract: docs/api/containers-services.md
const STATE = {
  running: { status: 'healthy', label: 'Running' },
  restarting: { status: 'warning', label: 'Restarting' },
  paused: { status: 'warning', label: 'Paused' },
  stopped: { status: 'unhealthy', label: 'Stopped' },
  exited: { status: 'unhealthy', label: 'Stopped' },
  created: { status: 'unknown', label: 'Not started' },
  removed: { status: 'unknown', label: 'Removed' },
};
const ORDER = { unhealthy: 0, warning: 1, unknown: 2, healthy: 3 };
const stateOf = (c) => STATE[c.state] || { status: 'unknown', label: 'Unknown' };

export default function ContainerList() {
  const { data, isLoading, error, refetch } = useApi(
    '/containers',
    {},
    {
      refetchInterval: 30000,
      retry: (count, e) => e.status !== 404 && count < 2,
    },
  );
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState(false);
  const navigate = useNavigate();
  const noData = (
    <EmptyState
      icon={Box}
      title="No Docker data yet"
      text="Add a Docker host and the containers running on it show up here. You do not need to add a server first."
      action={{ label: 'Monitor Docker containers', onClick: () => setDialog(true) }}
    />
  );
  const missing = error?.status === 404;
  const rows = useMemo(() => {
    const list = Array.isArray(data) ? data : (data?.items ?? []);
    const q = search.trim().toLowerCase();
    return list
      .filter(
        (c) => !q || [c.name, c.image, c.serverName].some((v) => v?.toLowerCase().includes(q)),
      )
      .sort(
        (a, b) =>
          (b.serverKind === 'docker-host') - (a.serverKind === 'docker-host') ||
          ORDER[stateOf(a).status] - ORDER[stateOf(b).status] || a.name.localeCompare(b.name),
      );
  }, [data, search]);
  const total = (Array.isArray(data) ? data : (data?.items ?? [])).length;

  return (
    <>
      <PageHeader
        title="Containers"
        description="Docker containers running on your Docker hosts and servers. Stopped ones are shown first."
        actions={
          <Button onClick={() => setDialog(true)}>
            <Plus className="size-4" aria-hidden="true" /> Monitor Docker containers
          </Button>
        }
      />
      <MonitorDockerDialog open={dialog} onOpenChange={setDialog} />
      {isLoading ? (
        <TableSkeleton />
      ) : missing || (!error && total === 0) ? (
        noData
      ) : error ? (
        <ErrorState title="We couldn't load your containers" error={error} onRetry={refetch} />
      ) : (
        <div className="space-y-4">
          <div className="relative w-full sm:max-w-sm">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              aria-label="Search containers"
              placeholder="Search by name, image or Docker host"
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <DataTable
            rows={rows}
            onRowClick={(c) => navigate(`/containers/${c.id}`)}
            empty={
              <p className="py-12 text-center text-sm text-muted-foreground">
                No container matches that search.
              </p>
            }
            columns={[
              {
                key: 'name',
                header: 'Container',
                cell: (c) => (
                  <div className="min-w-0">
                    <Link
                      to={`/containers/${c.id}`}
                      className="rounded-sm text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {c.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">{c.image}</p>
                  </div>
                ),
              },
              {
                key: 'state',
                header: 'State',
                cell: (c) => <StatusBadge status={stateOf(c).status} label={stateOf(c).label} />,
              },
              {
                key: 'restarts',
                header: 'Restarts',
                className: 'tabular-nums',
                cell: (c) => c.restarts ?? 0,
              },
              {
                key: 'cpuPercent',
                header: 'CPU',
                className: 'tabular-nums',
                cell: (c) => formatPercent(c.cpuPercent, 1),
              },
              {
                key: 'memoryBytes',
                header: 'Memory',
                className: 'tabular-nums',
                cell: (c) => formatBytes(c.memoryBytes, 0),
              },
              {
                key: 'serverName',
                header: 'Docker host',
                cell: (c) =>
                  c.serverId ? (
                    <Link
                      to={`/servers/${c.serverId}`}
                      className="underline-offset-4 hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {c.serverName || 'Docker host'}
                    </Link>
                  ) : (
                    c.serverName || '-'
                  ),
              },
              {
                key: 'lastSeen',
                header: 'Last seen',
                cell: (c) => <RelativeTime value={c.lastSeen} className="text-muted-foreground" />,
              },
            ]}
          />
        </div>
      )}
    </>
  );
}
