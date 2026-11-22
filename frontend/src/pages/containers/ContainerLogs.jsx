import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowDown, Download, RefreshCw, ScrollText } from 'lucide-react';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { api, download, session } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';
import { SelectField } from '@/pages/apps/shared';
import { LEVELS, LOG_RANGES, STREAMS, atBottom, linesToText, logParams, mergeLines, normalizeLevel } from './logs-model';

const TAIL_MS = 2000;
const LEVEL_TEXT = {
  error: 'text-destructive',
  warn: 'text-warning',
  info: 'text-chart-2',
  debug: 'text-muted-foreground',
};
const RANGE_OPTIONS = LOG_RANGES.map((r) => ({ value: r.key, label: r.label }));

const fetchLogs = (id, params) => api(`/containers/${id}/logs`, { params });

function readFilters(params) {
  const range = params.get('range');
  return {
    q: params.get('q') || '',
    level: params.get('level') || '',
    stream: params.get('stream') || '',
    range: LOG_RANGES.some((r) => r.key === range) ? range : '1h',
  };
}

const clock = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '';
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

function LogLine({ line }) {
  const level = normalizeLevel(line.level);
  return (
    <li
      className={cn(
        'grid grid-cols-[auto_auto_minmax(0,1fr)] gap-x-3 px-3 py-0.5 hover:bg-muted/60',
        level === 'error' && 'bg-destructive/5',
        level === 'warn' && 'bg-warning/5',
      )}
    >
      <time dateTime={line.time} title={new Date(line.time).toLocaleString()} className="text-muted-foreground tabular-nums">
        {clock(line.time)}
      </time>
      <span className={cn('w-12 font-semibold uppercase', LEVEL_TEXT[level] || 'text-muted-foreground/60')}>
        {level || (line.stream === 'stderr' ? 'err' : '·')}
        <span className="sr-only">{line.stream ? ` (${line.stream})` : ''}</span>
      </span>
      <span className={cn('whitespace-pre-wrap break-all', line.stream === 'stderr' && !level && 'text-destructive/90')}>{line.message}</span>
    </li>
  );
}

/** Whether the agent collects this container's logs: from the API when it says, else our last toggle. */
function useCollecting(container, hasLines) {
  const fromApi = container.logsEnabled ?? container.logs?.enabled ?? container.logCollection?.enabled;
  const [local, setLocal] = useState(null);
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: (enabled) => api(`/containers/${container.id}/logs`, { method: 'PATCH', body: { enabled } }),
    onSuccess: (data, enabled) => {
      setLocal(typeof data?.enabled === 'boolean' ? data.enabled : enabled);
      toast.success(
        data?.message ||
          (enabled ? 'Log collection is on. The agent starts sending lines within a minute.' : 'Log collection is off for this container.'),
      );
      client.invalidateQueries({ queryKey: [session.org, `/containers/${container.id}`] });
    },
    onError: (e) => toast.error(e.message),
  });
  const collecting = local ?? (typeof fromApi === 'boolean' ? fromApi : hasLines);
  return { collecting, known: local !== null || typeof fromApi === 'boolean', mutation };
}

export default function ContainerLogs({ container }) {
  const { canEdit } = useSession();
  const [params, setParams] = useSearchParams();
  const f = readFilters(params);
  const set = (patch) =>
    setParams(
      (old) => {
        const next = new URLSearchParams(old);
        for (const [k, v] of Object.entries(patch)) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        return next;
      },
      { replace: true },
    );
  const filterKey = JSON.stringify(f);

  const [lines, setLines] = useState([]);
  const [live, setLive] = useState(false);
  const [tailError, setTailError] = useState(null);
  const [stick, setStick] = useState(true);
  const cursor = useRef(null);
  const box = useRef(null);

  const initial = useQuery({
    queryKey: [session.org, 'containers', container.id, 'logs', filterKey],
    queryFn: () => fetchLogs(container.id, logParams(f)),
    retry: (count, e) => ![400, 402, 403, 404, 429].includes(e.status) && count < 1,
    staleTime: Infinity,
  });

  // A new first page (filters changed or refreshed) replaces the lines and the tail cursor.
  useEffect(() => {
    if (!initial.data) return;
    const items = initial.data.items ?? [];
    setLines(mergeLines([], items));
    cursor.current = initial.data.nextSince || items.at(-1)?.time || null;
    setStick(true);
  }, [initial.data]);

  // Live tail: poll every 2 s from nextSince with the same filters.
  useEffect(() => {
    if (!live) return undefined;
    let stopped = false;
    let busy = false;
    const tick = async () => {
      if (busy || stopped || !initial.data) return;
      busy = true;
      try {
        const res = await fetchLogs(container.id, logParams(f, { since: cursor.current || undefined }));
        if (stopped) return;
        setTailError(null);
        if (res?.items?.length) setLines((old) => mergeLines(old, res.items));
        if (res?.nextSince) cursor.current = res.nextSince;
      } catch (e) {
        if (!stopped) setTailError(e);
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(tick, TAIL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, filterKey, container.id, Boolean(initial.data)]);

  // Keep the newest line in view unless the reader scrolled up.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [lines, stick]);

  const { collecting, known, mutation } = useCollecting(container, lines.length > 0);
  const filtered = Boolean(f.q || f.level || f.stream);
  const quota = [initial.error, tailError].find((e) => e?.details?.code === 'logs_quota');

  const toggle = canEdit && (
    <Button
      type="button"
      variant={collecting ? 'outline' : 'default'}
      disabled={mutation.isPending}
      onClick={() => mutation.mutate(!collecting)}
    >
      {mutation.isPending ? 'Saving…' : collecting ? 'Stop collecting' : 'Collect logs'}
    </Button>
  );

  return (
    <div className="space-y-4">
      <Card className="surface card-accent">
        <CardContent className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-4">
            <Label htmlFor="cl-q">Search</Label>
            <Input
              id="cl-q"
              type="search"
              defaultValue={f.q}
              key={f.q}
              placeholder="connection refused"
              onKeyDown={(e) => e.key === 'Enter' && set({ q: e.currentTarget.value.trim() })}
              onBlur={(e) => e.target.value.trim() !== f.q && set({ q: e.target.value.trim() })}
            />
          </div>
          <SelectField id="cl-level" label="Level" value={f.level} onChange={(v) => set({ level: v })} options={LEVELS} />
          <SelectField id="cl-stream" label="Stream" value={f.stream} onChange={(v) => set({ stream: v })} options={STREAMS} />
          <SelectField id="cl-range" label="Time range" value={f.range} onChange={(v) => set({ range: v === '1h' ? '' : v })} options={RANGE_OPTIONS} />
          <div className="flex items-center gap-3 self-end pb-2">
            <Switch id="cl-live" checked={live} onCheckedChange={setLive} />
            <Label htmlFor="cl-live">Live tail</Label>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <p role="status" className="mr-auto text-sm text-muted-foreground">
          {live
            ? tailError
              ? 'Live tail lost connection. Retrying…'
              : 'Live: new lines appear every 2 seconds.'
            : `${lines.length} line${lines.length === 1 ? '' : 's'}`}
          {known && !collecting && ' · Collection is off for this container.'}
        </p>
        {!live && (
          <Button type="button" variant="outline" size="sm" onClick={() => initial.refetch()} disabled={initial.isFetching}>
            <RefreshCw className={cn('size-4', initial.isFetching && 'animate-spin')} aria-hidden="true" /> Refresh
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!lines.length}
          onClick={() => download(`${container.name}-logs.txt`, linesToText(lines))}
        >
          <Download className="size-4" aria-hidden="true" /> Download
        </Button>
        {toggle}
      </div>

      {quota && (
        <p role="alert" className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
          Log quota reached. New lines are paused until your telemetry quota resets or you upgrade your plan.
        </p>
      )}

      {initial.isPending ? (
        <TableSkeleton />
      ) : initial.isError && !quota ? (
        <ErrorState
          title="We couldn't load logs"
          error={initial.error?.status === 503 ? 'Log storage is unavailable. Try again shortly.' : initial.error}
          onRetry={() => initial.refetch()}
        />
      ) : lines.length === 0 && !live ? (
        filtered ? (
          <EmptyState
            icon={ScrollText}
            title="No lines match these filters"
            text="Try a longer time range or a shorter search."
            action={{ label: 'Clear filters', onClick: () => set({ q: '', level: '', stream: '' }) }}
          />
        ) : collecting ? (
          <EmptyState icon={ScrollText} title="No log lines in this time range" text="Turn on live tail to watch new lines arrive." />
        ) : (
          <EmptyState
            icon={ScrollText}
            title="Logs aren't collected for this container yet"
            text="Turn on log collection and the agent starts sending this container's stdout and stderr within a minute. Lines count against your telemetry quota."
            action={canEdit ? { label: 'Collect logs', onClick: () => mutation.mutate(true) } : undefined}
          />
        )
      ) : (
        <div className="relative">
          <div
            ref={box}
            onScroll={(e) => setStick(atBottom(e.currentTarget))}
            className="h-[60vh] min-h-72 overflow-y-auto rounded-2xl border bg-card py-2 font-mono text-xs leading-5"
            tabIndex={0}
            aria-label="Log lines"
          >
            {lines.length === 0 ? (
              <p className="px-3 text-muted-foreground">Waiting for new lines…</p>
            ) : (
              <ul>
                {lines.map((l, i) => (
                  <LogLine key={`${l.time}-${i}`} line={l} />
                ))}
              </ul>
            )}
          </div>
          {!stick && (
            <Button
              type="button"
              size="sm"
              className="absolute bottom-4 right-6 shadow-md"
              onClick={() => setStick(true)}
            >
              <ArrowDown className="size-4" aria-hidden="true" /> Jump to latest
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
