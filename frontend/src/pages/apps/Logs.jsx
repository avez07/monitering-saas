import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import { EmptyState, PageHeader, TableSkeleton } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { session } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { getLogs } from './api';
import { AttributeFilter, ServiceSelect, readFilters, writeFilters } from './Filters';
import { SEVERITY_ORDER, listQuery } from './model';
import { QueryError, RangeSelect, SelectField } from './shared';

const SEVERITY_OPTIONS = [
  { value: '', label: 'All levels' },
  ...SEVERITY_ORDER.map((s) => ({ value: s, label: `${s[0].toUpperCase()}${s.slice(1)} and above` })),
];
const DOT = {
  fatal: 'bg-destructive',
  error: 'bg-destructive',
  warn: 'bg-chart-4',
  info: 'bg-chart-2',
  debug: 'bg-muted-foreground',
  trace: 'bg-muted-foreground',
};
const MAX_TAIL = 1000;

function LogRow({ log }) {
  const [open, setOpen] = useState(false);
  const attrs = Object.entries({ ...log.attributes });
  return (
    <li className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
        <time dateTime={log.timestamp}>{formatDateTime(log.timestamp)}</time>
        <span className="inline-flex items-center gap-1.5 font-medium uppercase text-foreground">
          <span className={cn('size-2 rounded-full', DOT[log.severity] || 'bg-muted-foreground')} aria-hidden="true" />
          {log.severity}
        </span>
        <span>{log.service}</span>
        {log.traceId && (
          <Link
            to={`/apps/traces/${log.traceId}`}
            className="rounded-sm text-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Jump to trace
          </Link>
        )}
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words font-mono">{log.body}</p>
      {attrs.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            className="rounded-sm text-muted-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? 'Hide' : 'Show'} details ({attrs.length})
          </button>
          {open && (
            <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,14rem)_1fr]">
              {attrs.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="break-all font-mono text-muted-foreground">{k}</dt>
                  <dd className="break-all font-mono">{String(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </li>
  );
}

export default function Logs() {
  const [params, setParams] = useSearchParams();
  const f = readFilters(params);
  const set = (patch) => setParams(writeFilters({ ...f, ...patch }), { replace: true });
  const filterKey = listQuery(f);

  const [live, setLive] = useState(false);
  const [tail, setTail] = useState([]);
  const [tailError, setTailError] = useState(null);
  const cursor = useRef(null);

  const query = useInfiniteQuery({
    queryKey: [session.org, 'apps', 'logs', filterKey],
    queryFn: ({ pageParam }) => getLogs(f, pageParam ? { before: pageParam } : {}),
    initialPageParam: '',
    getNextPageParam: (last) =>
      last.hasMore && last.items.length ? last.items[last.items.length - 1].timestamp : undefined,
    retry: false,
  });
  const first = query.data?.pages[0];

  // Reset the tail whenever the filters change or live mode is switched.
  useEffect(() => {
    setTail([]);
    setTailError(null);
    cursor.current = null;
  }, [filterKey, live]);
  useEffect(() => {
    if (live && first?.cursor && !cursor.current) cursor.current = first.cursor;
  }, [live, first]);

  useEffect(() => {
    if (!live) return undefined;
    let stopped = false;
    const id = setInterval(async () => {
      if (!cursor.current) return;
      try {
        const res = await getLogs(f, { after: cursor.current });
        if (stopped) return;
        setTailError(null);
        if (res.items.length) setTail((old) => [...res.items, ...old].slice(0, MAX_TAIL));
        if (res.cursor) cursor.current = res.cursor;
      } catch (e) {
        if (!stopped) setTailError(e);
      }
    }, 1500);
    return () => {
      stopped = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, filterKey]);

  const stored = query.data?.pages.flatMap((p) => p.items) ?? [];
  const ids = new Set(tail.map((l) => l.id));
  const items = live ? [...tail, ...stored.filter((l) => !ids.has(l.id))] : stored;
  const filtered = Boolean(f.q || f.service || f.severity || f.traceId || f.attributes.length);

  return (
    <div className="page">
      <PageHeader
        title="Logs"
        description="Search the logs your apps send. Open the trace behind any line."
        breadcrumbs={[{ label: 'Apps', to: '/apps' }, { label: 'Logs' }]}
      />
      <Card className="surface card-accent mb-6">
        <CardContent className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
            <Label htmlFor="f-q">Search</Label>
            <Input
              id="f-q"
              type="search"
              defaultValue={f.q}
              key={f.q}
              placeholder="payment failed"
              onKeyDown={(e) => e.key === 'Enter' && set({ q: e.currentTarget.value.trim() })}
              onBlur={(e) => e.target.value.trim() !== f.q && set({ q: e.target.value.trim() })}
            />
            <p className="text-sm text-muted-foreground">Lines must contain every word (up to 5).</p>
          </div>
          <ServiceSelect value={f.service} onChange={(v) => set({ service: v })} />
          <SelectField id="f-sev" label="Level" value={f.severity} onChange={(v) => set({ severity: v })} options={SEVERITY_OPTIONS} />
          <RangeSelect value={f.range} onChange={(v) => set({ range: v })} />
          <div className="space-y-1.5">
            <Label htmlFor="f-trace">Trace id</Label>
            <Input
              id="f-trace"
              defaultValue={f.traceId}
              key={f.traceId}
              className="font-mono"
              placeholder="32-character trace id"
              onKeyDown={(e) => e.key === 'Enter' && set({ traceId: e.currentTarget.value.trim() })}
              onBlur={(e) => e.target.value.trim() !== f.traceId && set({ traceId: e.target.value.trim() })}
            />
          </div>
          <AttributeFilter attributes={f.attributes} onChange={(a) => set({ attributes: a })} />
          <div className="flex items-center gap-3 self-end pb-2">
            <Switch id="live" checked={live} onCheckedChange={setLive} />
            <Label htmlFor="live">Live tail</Label>
          </div>
        </CardContent>
      </Card>

      {live && (
        <p role="status" className="mb-3 text-sm text-muted-foreground">
          {tailError ? 'Live tail lost connection. Retrying…' : 'Live: new lines appear here every second or two.'}
        </p>
      )}

      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <QueryError query={query} title="We couldn't load logs" />
      ) : items.length === 0 ? (
        filtered ? (
          <EmptyState
            icon={ScrollText}
            title="No logs match these filters"
            text="Try a longer time range or fewer words."
            action={{ label: 'Clear filters', onClick: () => setParams({ range: f.range }) }}
          />
        ) : (
          <EmptyState
            icon={ScrollText}
            title="No logs yet"
            text="Send logs with the OpenTelemetry SDK or the Collector's filelog receiver."
            action={{ label: 'Connect your app', to: '/apps/connect' }}
          />
        )
      ) : (
        <>
          <ul className="space-y-2" aria-label="Log lines">
            {items.map((log) => (
              <LogRow key={log.id} log={log} />
            ))}
          </ul>
          {!live && query.hasNextPage && (
            <div className="mt-4 text-center">
              <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
                {query.isFetchingNextPage ? 'Loading…' : 'Show older lines'}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
