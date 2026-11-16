import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ScrollText } from 'lucide-react';
import {
  ChartCard,
  DataTable,
  EmptyState,
  PageHeader,
  RelativeTime,
  StatCard,
  StatGridSkeleton,
  TimeSeriesChart,
} from '@/components/app';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatMs, formatNumber, formatPercent } from '@/lib/format';
import { getService, useCall } from './api';
import { AppStatus, QueryError, RangeSelect, TraceLink } from './shared';

const endpointColumns = [
  { key: 'endpoint', header: 'Endpoint', cell: (e) => <code className="text-sm">{e.endpoint}</code> },
  { key: 'requests', header: 'Requests', cell: (e) => formatNumber(e.requests), className: 'tabular-nums' },
  { key: 'errors', header: 'Errors', cell: (e) => formatPercent(e.errorPercent, 1), className: 'tabular-nums' },
  { key: 'avg', header: 'Average', cell: (e) => formatMs(e.avgMs), className: 'tabular-nums' },
  { key: 'p95', header: 'p95', cell: (e) => formatMs(e.p95Ms), className: 'tabular-nums' },
];

function EndpointTable({ title, rows }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <DataTable
          columns={endpointColumns}
          rows={rows}
          getKey={(e) => e.endpoint}
          empty={<p className="text-muted-foreground">Nothing to show for this time range.</p>}
        />
      </CardContent>
    </Card>
  );
}

const none = <p className="text-muted-foreground">No requests in this time range.</p>;

export default function ServiceDetail() {
  const { name } = useParams();
  const [params, setParams] = useSearchParams();
  const range = params.get('range') || '1h';
  const query = useCall(['service', name, range], () => getService(name, range), {
    refetchInterval: 30000,
  });
  const crumbs = [{ label: 'Apps', to: '/apps' }, { label: name }];

  if (query.isError)
    return (
      <>
        <PageHeader title={name} breadcrumbs={crumbs} />
        {query.error?.status === 404 ? (
          <EmptyState
            title="No data for this app in this time range"
            text="Try a longer time range, or check the app is still sending data."
            action={{ label: 'Back to all apps', to: '/apps' }}
          />
        ) : (
          <QueryError query={query} title="We couldn't load this app" />
        )}
      </>
    );

  const data = query.data;
  const s = data?.service;
  const series = data?.series ?? [];
  const empty = !series.length && none;

  return (
    <>
      <PageHeader
        title={name}
        breadcrumbs={crumbs}
        actions={
          <>
            <Button asChild variant="outline">
              <Link to={`/apps/logs?service=${encodeURIComponent(name)}`}>
                <ScrollText className="size-4" aria-hidden="true" /> View logs
              </Link>
            </Button>
            <Button asChild>
              <Link to={`/apps/traces?service=${encodeURIComponent(name)}&range=${range}`}>
                View traces
              </Link>
            </Button>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <div className="w-full max-w-xs">
          <RangeSelect value={range} onChange={(v) => setParams({ range: v })} />
        </div>
        {s && <AppStatus status={s.status} />}
      </div>

      {query.isPending ? (
        <StatGridSkeleton />
      ) : (
        <div className="space-y-6">
          <section aria-label="Summary" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Requests"
              value={formatNumber(s.requests)}
              hint={`${Number(s.ratePerSecond).toFixed(2)} per second`}
            />
            <StatCard
              label="Errors"
              value={formatPercent(s.errorPercent, 1)}
              hint={`${formatNumber(s.errors)} failed`}
            />
            <StatCard label="Typical speed (p50)" value={formatMs(s.p50Ms)} />
            <StatCard
              label="Slowest 5% (p95)"
              value={formatMs(s.p95Ms)}
              hint={`p99 ${formatMs(s.p99Ms)}`}
            />
          </section>

          <div className="grid gap-6 lg:grid-cols-3">
            <ChartCard title="Requests" description="Per second" empty={empty}>
              <TimeSeriesChart
                data={series}
                series={[{ key: 'ratePerSecond', label: 'Requests per second' }]}
                format={(v) => Number(v).toFixed(2)}
              />
            </ChartCard>
            <ChartCard title="Errors" description="Share of requests that failed" empty={empty}>
              <TimeSeriesChart
                data={series}
                series={[{ key: 'errorPercent', label: 'Errors' }]}
                format={(v) => formatPercent(v, 1)}
                domain={[0, 'auto']}
              />
            </ChartCard>
            <ChartCard title="Duration" description="How long requests take" empty={empty}>
              <TimeSeriesChart
                type="line"
                data={series}
                series={[
                  { key: 'p50Ms', label: 'Typical (p50)' },
                  { key: 'p95Ms', label: 'Slowest 5% (p95)' },
                  { key: 'p99Ms', label: 'Slowest 1% (p99)' },
                ]}
                format={formatMs}
              />
            </ChartCard>
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <EndpointTable title="Slowest endpoints" rows={data.topEndpoints?.slowest ?? []} />
            <EndpointTable
              title="Endpoints with the most errors"
              rows={data.topEndpoints?.mostErrors ?? []}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent errors, grouped by type</CardTitle>
            </CardHeader>
            <CardContent>
              <DataTable
                columns={[
                  { key: 'type', header: 'Error type', cell: (e) => <code className="text-sm">{e.type}</code> },
                  {
                    key: 'message',
                    header: 'Message',
                    cell: (e) => <span className="line-clamp-2 break-words">{e.message}</span>,
                  },
                  { key: 'count', header: 'Times', cell: (e) => formatNumber(e.count), className: 'tabular-nums' },
                  { key: 'last', header: 'Last seen', cell: (e) => <RelativeTime value={e.lastSeen} /> },
                  {
                    key: 'trace',
                    header: 'Example',
                    cell: (e) =>
                      e.sampleTraceId ? <TraceLink id={e.sampleTraceId}>Open trace</TraceLink> : '-',
                  },
                ]}
                rows={data.errors ?? []}
                getKey={(e) => `${e.type}-${e.message}`}
                empty={<p className="text-muted-foreground">No errors in this time range.</p>}
              />
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
