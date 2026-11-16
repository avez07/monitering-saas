import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ScrollText } from 'lucide-react';
import { CopyField, EmptyState, PageHeader, StatCard, StatGridSkeleton } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { formatDateTime, formatMs } from '@/lib/format';
import { getTrace, useCall } from './api';
import { waterfallRows } from './model';
import { QueryError } from './shared';

function Attributes({ title, data }) {
  const entries = Object.entries(data ?? {});
  if (!entries.length) return null;
  return (
    <section aria-label={title}>
      <h4 className="mb-2 text-sm font-semibold">{title}</h4>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(0,14rem)_1fr]">
        {entries.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="break-all font-mono text-muted-foreground">{k}</dt>
            <dd className="break-all font-mono">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function SpanDetails({ span }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="break-words text-base">{span.name}</CardTitle>
        <p className="text-sm text-muted-foreground">
          {span.service} · {span.kind} · {formatMs(span.durationMs)} · starts at{' '}
          {formatMs(span.startOffsetMs)}
        </p>
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <span
            className={cn('size-2 rounded-full', span.status === 'error' ? 'bg-destructive' : 'bg-chart-2')}
            aria-hidden="true"
          />
          {span.status === 'error' ? 'Failed' : 'Succeeded'}
          {span.statusMessage ? `: ${span.statusMessage}` : ''}
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <Attributes title="Attributes" data={span.attributes} />
        <Attributes title="About the service" data={span.resourceAttributes} />
        {span.events?.length > 0 && (
          <section aria-label="Events">
            <h4 className="mb-2 text-sm font-semibold">Events</h4>
            <ul className="space-y-3">
              {span.events.map((e, i) => (
                <li key={i} className="rounded-md border p-3">
                  <p className="text-sm font-medium">
                    {e.name} <span className="font-normal text-muted-foreground">at {formatMs(e.offsetMs)}</span>
                  </p>
                  <div className="mt-2">
                    <Attributes title="Event details" data={e.attributes} />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        {span.links?.length > 0 && (
          <section aria-label="Links">
            <h4 className="mb-2 text-sm font-semibold">Linked traces</h4>
            <ul className="space-y-1 text-sm">
              {span.links.map((l, i) => (
                <li key={i}>
                  <Link className="font-mono underline underline-offset-4" to={`/apps/traces/${l.traceId}`}>
                    {l.traceId}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
        <p className="text-sm text-muted-foreground">Recorded by {span.scope || 'unknown'}</p>
      </CardContent>
    </Card>
  );
}

export default function TraceDetail() {
  const { id } = useParams();
  const query = useCall(['trace', id], () => getTrace(id));
  const [selected, setSelected] = useState(null);
  const crumbs = [{ label: 'Apps', to: '/apps' }, { label: 'Traces', to: '/apps/traces' }, { label: id.slice(0, 8) }];

  if (query.isError)
    return (
      <>
        <PageHeader title="Trace" breadcrumbs={crumbs} />
        {query.error?.status === 404 ? (
          <EmptyState
            title="We can't find this trace"
            text="It may be older than your plan keeps, or it was filtered out by sampling."
            action={{ label: 'Back to traces', to: '/apps/traces' }}
          />
        ) : (
          <QueryError query={query} title="We couldn't load this trace" />
        )}
      </>
    );
  if (query.isPending)
    return (
      <>
        <PageHeader title="Trace" breadcrumbs={crumbs} />
        <StatGridSkeleton />
      </>
    );

  const trace = query.data;
  const rows = waterfallRows(trace);
  const current = rows.find((r) => r.span.spanId === selected)?.span ?? rows[0]?.span;
  const root = rows[0]?.span;

  return (
    <>
      <PageHeader
        title={root?.name || 'Trace'}
        breadcrumbs={crumbs}
        description={formatDateTime(trace.startTime)}
        actions={
          <Button asChild variant="outline">
            <Link to={`/apps/logs?traceId=${trace.traceId}`}>
              <ScrollText className="size-4" aria-hidden="true" /> Logs for this trace
            </Link>
          </Button>
        }
      />
      <section aria-label="Summary" className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Duration" value={formatMs(trace.durationMs)} />
        <StatCard label="Steps" value={trace.spanCount} />
        <StatCard label="Failed steps" value={trace.errorCount} hint={trace.errorCount ? 'Look for the red bars' : 'Everything succeeded'} />
      </section>
      <CopyField value={trace.traceId} label="trace id" className="mb-6" />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Timeline</CardTitle>
          <p className="text-sm text-muted-foreground">Select a step to see its details.</p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <ul className="min-w-[36rem] space-y-1" aria-label="Spans">
              {rows.map(({ span, depth, left, width }) => {
                const failed = span.status === 'error';
                const active = span.spanId === current?.spanId;
                return (
                  <li key={span.spanId}>
                    <button
                      type="button"
                      onClick={() => setSelected(span.spanId)}
                      aria-pressed={active}
                      className={cn(
                        'grid w-full grid-cols-[minmax(10rem,14rem)_1fr_4.5rem] items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        active && 'bg-accent',
                      )}
                    >
                      <span className="min-w-0" style={{ paddingLeft: `${Math.min(depth, 8) * 12}px` }}>
                        <span className="block truncate font-medium">
                          {failed && <span className="mr-1 text-destructive">Failed:</span>}
                          {span.name}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">{span.service}</span>
                      </span>
                      <span className="relative h-4 rounded bg-muted" aria-hidden="true">
                        <span
                          className={cn('absolute inset-y-0 rounded', failed ? 'bg-destructive' : 'bg-chart-2')}
                          style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                        />
                      </span>
                      <span className="text-right tabular-nums">{formatMs(span.durationMs)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </CardContent>
      </Card>

      {current && <SpanDetails span={current} />}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Related logs</CardTitle>
        </CardHeader>
        <CardContent>
          {trace.logs?.length ? (
            <>
              <ul className="space-y-2">
                {trace.logs.map((l, i) => (
                  <li key={i} className="rounded-md border p-3 text-sm">
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                      <time dateTime={l.timestamp}>{formatDateTime(l.timestamp)}</time>
                      <span className="font-medium uppercase text-foreground">{l.severity}</span>
                      <span>{l.service}</span>
                    </p>
                    <p className="mt-1 break-words font-mono">{l.body}</p>
                  </li>
                ))}
              </ul>
              <Button asChild variant="outline" className="mt-4">
                <Link to={`/apps/logs?traceId=${trace.traceId}`}>Open in the log explorer</Link>
              </Button>
            </>
          ) : (
            <p className="text-muted-foreground">
              No logs are linked to this trace. Add the trace id to your logs to see them here.{' '}
              <Link to="/apps/connect" className="underline underline-offset-4">
                How to link logs
              </Link>
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
