import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Box, Search } from 'lucide-react';
import {
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  RelativeTime,
  StatusBadge,
  TableSkeleton,
} from '@/components/app';
import { Input } from '@/components/ui/input';
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

const noData = (
  <EmptyState
    icon={Box}
    title="No Docker data yet"
    text="Turn on Containers in your server settings and the containers running on that server show up here."
    action={{ label: 'Open your servers', to: '/servers' }}
  />
);

export default function Containers() {
  const { data, isLoading, error, refetch } = useApi(
    '/containers',
    {},
    {
      refetchInterval: 30000,
      retry: (count, e) => e.status !== 404 && count < 2,
    },
  );
  const [search, setSearch] = useState('');
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
          ORDER[stateOf(a).status] - ORDER[stateOf(b).status] || a.name.localeCompare(b.name),
      );
  }, [data, search]);
  const total = (Array.isArray(data) ? data : (data?.items ?? [])).length;

  return (
    <>
      <PageHeader
        title="Containers"
        description="Docker containers running on your servers. Stopped ones are shown first."
      />
      {isLoading ? (
        <TableSkeleton />
      ) : missing || (!error && total === 0) ? (
        noData
      ) : error ? (
        <ErrorState title="We couldn't load your containers" error={error} onRetry={refetch} />
      ) : (
        <div className="space-y-4">
          <div className="relative max-w-sm">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              aria-label="Search containers"
              placeholder="Search by name, image or server"
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <DataTable
            rows={rows}
            empty={
              <p className="py-8 text-center text-muted-foreground">
                No container matches that search.
              </p>
            }
            columns={[
              {
                key: 'name',
                header: 'Container',
                cell: (c) => (
                  <div className="min-w-0">
                    <p className="font-medium">{c.name}</p>
                    <p className="text-sm text-muted-foreground">{c.image}</p>
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
                header: 'Server',
                cell: (c) =>
                  c.serverId ? (
                    <Link
                      to={`/servers/${c.serverId}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {c.serverName || 'Server'}
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
