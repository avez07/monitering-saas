import { Link, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Plug } from 'lucide-react';
import { DataTable, EmptyState, PageHeader, RelativeTime, TableSkeleton } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { session } from '@/lib/api';
import { formatMs } from '@/lib/format';
import { getTraces } from './api';
import { AttributeFilter, ServiceSelect, readFilters, writeFilters } from './Filters';
import { listQuery } from './model';
import { QueryError, RangeSelect, SelectField, TraceLink } from './shared';

const STATUS_OPTIONS = [
  { value: '', label: 'Any' },
  { value: 'error', label: 'Failed' },
  { value: 'ok', label: 'Succeeded' },
];

export default function Traces() {
  const [params, setParams] = useSearchParams();
  const f = readFilters(params);
  const set = (patch) => setParams(writeFilters({ ...f, ...patch }), { replace: true });

  const query = useInfiniteQuery({
    queryKey: [session.org, 'apps', 'traces', listQuery(f)],
    queryFn: ({ pageParam }) => getTraces(f, pageParam ? { before: pageParam } : {}),
    initialPageParam: '',
    getNextPageParam: (last) =>
      last.hasMore && last.items.length ? last.items[last.items.length - 1].startTime : undefined,
    retry: false,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = Boolean(f.service || f.endpoint || f.status || f.minDurationMs || f.attributes.length);

  const columns = [
    {
      key: 'name',
      header: 'Request',
      cell: (t) => (
        <span className="flex flex-col">
          <span className="font-medium">{t.rootName}</span>
          <span className="text-sm text-muted-foreground">{t.rootService}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Result',
      cell: (t) =>
        t.errorCount > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium">
            <span className="size-2 rounded-full bg-destructive" aria-hidden="true" />
            Failed ({t.errorCount})
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium">
            <span className="size-2 rounded-full bg-chart-2" aria-hidden="true" />
            Succeeded
          </span>
        ),
    },
    { key: 'duration', header: 'Duration', cell: (t) => formatMs(t.durationMs), className: 'tabular-nums' },
    { key: 'spans', header: 'Steps', cell: (t) => t.spanCount, className: 'tabular-nums' },
    { key: 'when', header: 'Started', cell: (t) => <RelativeTime value={t.startTime} /> },
    { key: 'id', header: 'Trace', cell: (t) => <TraceLink id={t.traceId} /> },
  ];

  return (
    <>
      <PageHeader
        title="Traces"
        description="Follow one request through all your services, step by step."
        breadcrumbs={[{ label: 'Apps', to: '/apps' }, { label: 'Traces' }]}
      />
      <Card className="mb-6">
        <CardContent className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
          <ServiceSelect value={f.service} onChange={(v) => set({ service: v })} />
          <div className="space-y-1.5">
            <Label htmlFor="f-endpoint">Endpoint</Label>
            <Input
              id="f-endpoint"
              defaultValue={f.endpoint}
              key={f.endpoint}
              placeholder="GET /orders"
              onBlur={(e) => e.target.value !== f.endpoint && set({ endpoint: e.target.value.trim() })}
              onKeyDown={(e) => e.key === 'Enter' && set({ endpoint: e.currentTarget.value.trim() })}
            />
          </div>
          <SelectField id="f-status" label="Result" value={f.status} onChange={(v) => set({ status: v })} options={STATUS_OPTIONS} />
          <div className="space-y-1.5">
            <Label htmlFor="f-dur">Slower than (ms)</Label>
            <Input
              id="f-dur"
              type="number"
              min="0"
              inputMode="numeric"
              defaultValue={f.minDurationMs}
              key={f.minDurationMs}
              placeholder="500"
              onBlur={(e) => e.target.value !== f.minDurationMs && set({ minDurationMs: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && set({ minDurationMs: e.currentTarget.value })}
            />
          </div>
          <RangeSelect value={f.range} onChange={(v) => set({ range: v })} />
          <AttributeFilter attributes={f.attributes} onChange={(a) => set({ attributes: a })} />
        </CardContent>
      </Card>

      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <QueryError query={query} title="We couldn't load traces" />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={items}
            getKey={(t) => t.traceId}
            empty={
              filtered ? (
                <EmptyState
                  icon={Plug}
                  title="No traces match these filters"
                  text="Try a longer time range or remove a filter."
                  action={{ label: 'Clear filters', onClick: () => setParams({ range: f.range }) }}
                />
              ) : (
                <EmptyState
                  icon={Plug}
                  title="No traces yet"
                  text="Connect an app with the OpenTelemetry SDK and its requests will show up here."
                  action={{ label: 'Connect your app', to: '/apps/connect' }}
                />
              )
            }
          />
          {query.hasNextPage && (
            <div className="mt-4 text-center">
              <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
                {query.isFetchingNextPage ? 'Loading…' : 'Show more'}
              </Button>
            </div>
          )}
          {items.length > 0 && (
            <p className="mt-3 text-sm text-muted-foreground">
              Looking at how a service did overall?{' '}
              <Link to="/apps" className="underline underline-offset-4">
                See all apps
              </Link>
            </p>
          )}
        </>
      )}
    </>
  );
}
