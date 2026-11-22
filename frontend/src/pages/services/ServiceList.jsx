import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search, Workflow } from 'lucide-react';
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
import AddServiceDialog from './AddServiceDialog';
import { useApi } from '@/lib/hooks';

// Contract: docs/api/containers-services.md (assumed until the Services collector ships).
const STATE = {
  running: { status: 'healthy', label: 'Running' },
  stopped: { status: 'unhealthy', label: 'Stopped' },
  failed: { status: 'unhealthy', label: 'Failed' },
  unknown: { status: 'unknown', label: 'Unknown' },
};
const TYPE = {
  systemd: 'System service',
  process: 'Program',
  port: 'Network port',
  web: 'Web server',
  database: 'Database',
  cache: 'Cache',
};
const ORDER = { unhealthy: 0, warning: 1, unknown: 2, healthy: 3 };
const stateOf = (s) => STATE[s.state] || STATE.unknown;

export default function ServiceList() {
  const { data, isLoading, error, refetch } = useApi(
    '/services',
    {},
    {
      refetchInterval: 30000,
      retry: (count, e) => e.status !== 404 && count < 2,
    },
  );
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState(false);
  const noData = (
    <EmptyState
      icon={Workflow}
      title="No services yet"
      text="Watch what runs on your hosts: databases, nginx, open ports, programs or any system service. Websites and APIs are under Websites & APIs."
      action={{ label: 'Add a service', onClick: () => setDialog(true) }}
    />
  );
  const all = Array.isArray(data) ? data : (data?.items ?? []);
  const missing = error?.status === 404;
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all
      .filter(
        (s) => !q || [s.name, s.serverName, TYPE[s.type]].some((v) => v?.toLowerCase().includes(q)),
      )
      .sort(
        (a, b) =>
          ORDER[stateOf(a).status] - ORDER[stateOf(b).status] || a.name.localeCompare(b.name),
      );
  }, [all, search]);

  return (
    <div className="page">
      <PageHeader
        title="Services"
        description="Things running on your servers, like web servers and databases. Problems are shown first."
        actions={
          <Button onClick={() => setDialog(true)}>
            <Plus className="size-4" aria-hidden="true" /> Add a service
          </Button>
        }
      />
      <AddServiceDialog open={dialog} onOpenChange={setDialog} />
      {isLoading ? (
        <TableSkeleton />
      ) : missing || (!error && all.length === 0) ? (
        noData
      ) : error ? (
        <ErrorState title="We couldn't load your services" error={error} onRetry={refetch} />
      ) : (
        <div className="space-y-5">
          <div className="relative w-full sm:max-w-xs">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              aria-label="Search services"
              placeholder="Search by name or server"
              className="h-9 pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <DataTable
            rows={rows}
            empty={
              <p className="py-8 text-center text-muted-foreground">
                No service matches that search.
              </p>
            }
            columns={[
              {
                key: 'name',
                header: 'Service',
                cell: (s) => (
                  <div className="min-w-0">
                    <p className="font-medium">
                      <Link to={`/services/${s.id}`} className="transition-colors hover:text-primary">
                        {s.name}
                      </Link>
                    </p>
                    {s.detail && <p className="text-xs text-muted-foreground">{s.detail}</p>}
                  </div>
                ),
              },
              { key: 'type', header: 'Type', cell: (s) => TYPE[s.type] || s.type || '-' },
              {
                key: 'state',
                header: 'State',
                cell: (s) => <StatusBadge status={stateOf(s).status} label={stateOf(s).label} />,
              },
              {
                key: 'serverName',
                header: 'Server',
                cell: (s) =>
                  s.serverId ? (
                    <Link
                      to={`/servers/${s.serverId}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {s.serverName || 'Server'}
                    </Link>
                  ) : (
                    s.serverName || '-'
                  ),
              },
              {
                key: 'lastChecked',
                header: 'Last checked',
                cell: (s) => (
                  <RelativeTime value={s.lastChecked} className="text-muted-foreground" />
                ),
              },
            ]}
          />
        </div>
      )}
    </div>
  );
}
