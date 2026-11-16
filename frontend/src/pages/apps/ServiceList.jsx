import { Link, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { DataTable, PageHeader, RelativeTime, TableSkeleton } from '@/components/app';
import { Button } from '@/components/ui/button';
import { formatMs, formatNumber, formatPercent } from '@/lib/format';
import { getServices, useCall } from './api';
import { AppStatus, NoDataState, QueryError, RangeSelect, Sparkline } from './shared';

export default function ServiceList() {
  const [params, setParams] = useSearchParams();
  const range = params.get('range') || '1h';
  const query = useCall(['services', range], () => getServices(range), { refetchInterval: 30000 });
  const items = query.data?.items ?? [];

  const columns = [
    {
      key: 'name',
      header: 'Service',
      cell: (s) => (
        <Link
          to={`/apps/services/${encodeURIComponent(s.name)}?range=${range}`}
          className="rounded-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {s.name}
        </Link>
      ),
    },
    { key: 'status', header: 'Status', cell: (s) => <AppStatus status={s.status} /> },
    {
      key: 'rate',
      header: 'Requests per second',
      cell: (s) => (s.hasTraces ? Number(s.ratePerSecond).toFixed(2) : '-'),
      className: 'tabular-nums',
    },
    {
      key: 'err',
      header: 'Errors',
      cell: (s) => (s.hasTraces ? formatPercent(s.errorPercent, 1) : '-'),
      className: 'tabular-nums',
    },
    {
      key: 'p95',
      header: 'Slowest 5% (p95)',
      cell: (s) => (s.hasTraces ? formatMs(s.p95Ms) : '-'),
      className: 'tabular-nums',
    },
    {
      key: 'trend',
      header: 'Trend',
      cell: (s) => <Sparkline points={s.sparkline} />,
    },
    {
      key: 'last',
      header: 'Last seen',
      cell: (s) => <RelativeTime value={s.lastSeen} />,
    },
  ];

  return (
    <>
      <PageHeader
        title="Apps"
        description="Every app that sends OpenTelemetry data, with how fast it is and how often it fails."
        actions={
          <Button asChild>
            <Link to="/apps/connect">
              <Plus className="size-4" aria-hidden="true" /> Connect an app
            </Link>
          </Button>
        }
      />
      <div className="mb-4 max-w-xs">
        <RangeSelect value={range} onChange={(v) => setParams({ range: v })} />
      </div>
      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <QueryError query={query} title="We couldn't load your apps" />
      ) : (
        <>
          {query.data?.clamped && (
            <p className="mb-3 text-sm text-muted-foreground">
              Showing the longest range your plan keeps.
            </p>
          )}
          <DataTable
            columns={columns}
            rows={items}
            getKey={(s) => s.name}
            empty={<NoDataState what="apps" />}
          />
          {items.length > 0 && (
            <p className="mt-3 text-sm text-muted-foreground">
              {formatNumber(items.length)} {items.length === 1 ? 'app' : 'apps'}. Updates every 30
              seconds.
            </p>
          )}
        </>
      )}
    </>
  );
}
