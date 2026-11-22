import { useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Info, Loader2 } from 'lucide-react';
import { BarGauge, Gauge, Pie, TimeSeriesChart, seriesColor } from '@/components/app/charts';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { session } from '@/lib/api';
import { cn } from '@/lib/utils';
import { queryInstant, queryRange, retryDelay, retryPolicy } from './api';
import {
  formatValue,
  interpolate,
  isInstant,
  panelVariables,
  reduceSeries,
  stepFor,
  themeColor,
  thresholdColor,
  toChartData,
  toTable,
} from './model';

/** True while the element is on (or near) the screen. Without IntersectionObserver: always true. */
export function useInView(ref, rootMargin = '300px 0px') {
  const [inView, setInView] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, rootMargin]);
  return inView;
}

const needsNode = (expr) => /\$\{?node\b/.test(expr);

/** Runs every target of a panel (only while visible) and returns one Prometheus result per target. */
function usePanelData(panel, ctx, widthPx, visible) {
  const stepSec = stepFor(ctx.rangeSec, widthPx);
  const vars = panelVariables({ ...ctx, stepSec });
  const targets = (panel.targets || []).filter((t) => t.expr && !t.hide);
  const queries = targets.map((t) => ({
    instant: isInstant(panel, t),
    query: interpolate(t.expr, vars),
  }));
  const waitingForNode = targets.some((t) => needsNode(t.expr)) && !ctx.node;
  const query = useQuery({
    queryKey: [session.org, 'dashboards', 'panel', queries, ctx.end, ctx.rangeSec, stepSec],
    queryFn: () =>
      Promise.all(
        queries.map((q) =>
          q.instant
            ? queryInstant({ query: q.query, time: ctx.end })
            : queryRange({ query: q.query, start: ctx.end - ctx.rangeSec, end: ctx.end, step: stepSec }),
        ),
      ),
    enabled: visible && queries.length > 0 && !waitingForNode,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    retry: retryPolicy,
    retryDelay,
  });
  return { query, targets, waitingForNode };
}

function Message({ children, tone }) {
  return (
    <div className={cn('flex h-full items-center justify-center px-2 text-center text-xs', tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
      {children}
    </div>
  );
}

function errorText(error) {
  if (error?.status === 429) return 'Too many queries right now. Retrying shortly.';
  if (error?.status === 400 || error?.status === 422) return error.message || 'This query could not run.';
  if (error?.status === 503 || error?.status === 502) return 'Metrics storage is unavailable. Try again shortly.';
  return error?.message || 'Could not load this panel.';
}

const fmt = (panel) => (v) => formatValue(v, panel.unit || 'short', panel.decimals);
const cssThresholds = (t) => (t || []).map((s) => ({ ...s, color: themeColor(s.color) }));

function TimeseriesViz({ panel, results, targets }) {
  const { data, series } = useMemo(() => toChartData(results, targets), [results, targets]);
  const [hidden, setHidden] = useState(() => new Set());
  if (!series.length || !data.length) return <Message>No data</Message>;
  const format = fmt(panel);
  const axis = (v) => formatValue(v, panel.unit || 'short', panel.decimals ?? undefined);
  const domain = panel.min != null || panel.max != null ? [panel.min ?? 'auto', panel.max ?? 'auto'] : undefined;
  const toggle = (key) =>
    setHidden((old) => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0">
          <TimeSeriesChart
            data={data}
            series={series}
            format={axis}
            type={panel.fill === 0 ? 'line' : 'area'}
            fillOpacity={panel.fill != null ? Math.min(1, panel.fill / 100) : 0.12}
            stacked={Boolean(panel.stacking)}
            domain={domain}
            height="100%"
            hidden={hidden}
            animate={false}
          />
        </div>
      </div>
      {series.length > 1 && (
        <ul className="mt-1 flex max-h-[34%] shrink-0 flex-wrap gap-x-3 gap-y-0.5 overflow-y-auto text-[11px] leading-5" aria-label="Legend">
          {series.map((s, i) => (
            <li key={s.key} className="min-w-0 max-w-full">
              <button
                type="button"
                onClick={() => toggle(s.key)}
                aria-pressed={!hidden.has(s.key)}
                title={`${s.label}: ${format(lastOf(data, s.key))}`}
                className={cn(
                  'flex max-w-full items-center gap-1.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  hidden.has(s.key) ? 'text-muted-foreground/50 line-through' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: seriesColor(i) }} aria-hidden="true" />
                <span className="truncate">{s.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const lastOf = (data, key) => {
  for (let i = data.length - 1; i >= 0; i--) if (data[i][key] != null) return data[i][key];
  return null;
};

function StatViz({ panel, results, targets, h }) {
  const items = reduceSeries(results, targets);
  if (!items.length) return <Message>No data</Message>;
  const format = fmt(panel);
  const big = items.length === 1;
  return (
    <div className={cn('grid h-full items-center gap-2', big ? 'grid-cols-1' : 'grid-cols-[repeat(auto-fit,minmax(6rem,1fr))]')}>
      {items.map((it, i) => (
        <div key={`${it.label}-${i}`} className="min-w-0 text-center">
          <p
            className={cn('truncate font-serif font-semibold tabular-nums', big ? (h <= 3 ? 'text-2xl' : 'text-3xl') : 'text-lg')}
            style={{ color: thresholdColor(it.value, panel.thresholds) || undefined }}
          >
            {format(it.value)}
          </p>
          {!big && <p className="truncate text-[11px] text-muted-foreground" title={it.label}>{it.label}</p>}
        </div>
      ))}
    </div>
  );
}

function defaultMax(panel) {
  if (panel.max != null) return panel.max;
  if (panel.unit === 'percentunit') return 1;
  return 100;
}

function GaugeViz({ panel, results, targets }) {
  const items = reduceSeries(results, targets);
  if (!items.length) return <Message>No data</Message>;
  const format = fmt(panel);
  return (
    <div className="flex h-full gap-2">
      {items.slice(0, 8).map((it, i) => (
        <div key={`${it.label}-${i}`} className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <Gauge
              value={it.value}
              min={panel.min ?? 0}
              max={defaultMax(panel)}
              color={thresholdColor(it.value, panel.thresholds)}
              thresholds={cssThresholds(panel.thresholds)}
              format={format}
              label={it.label || panel.title}
            />
          </div>
          {items.length > 1 && <p className="truncate text-center text-[11px] text-muted-foreground">{it.label}</p>}
        </div>
      ))}
    </div>
  );
}

function BarGaugeViz({ panel, results, targets }) {
  const items = reduceSeries(results, targets).map((it, i) => ({
    ...it,
    color: thresholdColor(it.value, panel.thresholds) || seriesColor(i),
  }));
  if (!items.length) return <Message>No data</Message>;
  return <BarGauge items={items} min={panel.min ?? 0} max={panel.max ?? undefined} format={fmt(panel)} />;
}

function PieViz({ panel, results, targets }) {
  const items = reduceSeries(results, targets);
  if (!items.some((i) => Number(i.value) > 0)) return <Message>No data</Message>;
  return <Pie items={items} format={fmt(panel)} />;
}

function TableViz({ panel, results, targets }) {
  const { columns, rows } = useMemo(() => toTable(results, targets), [results, targets]);
  if (!rows.length) return <Message>No data</Message>;
  const format = fmt(panel);
  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-card">
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cn('whitespace-nowrap border-b px-2 py-1.5 font-medium text-muted-foreground', c.value && 'text-right')}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-border/50 last:border-0">
              {columns.map((c) => (
                <td key={c.key} className={cn('whitespace-nowrap px-2 py-1', c.value ? 'text-right tabular-nums' : 'font-mono')}>
                  {c.value ? (
                    <span style={{ color: thresholdColor(r[c.key], panel.thresholds) || undefined }}>{format(r[c.key])}</span>
                  ) : (
                    (r[c.key] ?? '')
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const VIZ = {
  timeseries: TimeseriesViz,
  graph: TimeseriesViz,
  stat: StatViz,
  singlestat: StatViz,
  gauge: GaugeViz,
  bargauge: BarGaugeViz,
  piechart: PieViz,
  table: TableViz,
};

/** One dashboard panel: title bar plus the visualisation. Queries run only while it's on screen. */
export function Panel({ panel, ctx, widthPx, h, onLocked, style }) {
  const ref = useRef(null);
  const visible = useInView(ref);
  const Viz = VIZ[panel.type];
  const { query, targets, waitingForNode } = usePanelData(panel, ctx, widthPx, visible && Boolean(Viz));

  useEffect(() => {
    if (query.error?.status === 402) onLocked?.();
  }, [query.error, onLocked]);

  let body;
  if (!Viz) body = <Message>This panel type ({panel.type}) is not supported yet.</Message>;
  else if (!targets.length) body = <Message>No queries</Message>;
  else if (waitingForNode) body = <Message>Pick a server</Message>;
  else if (query.isError && !query.data)
    body = (
      <Message tone="error">
        <AlertTriangle className="mr-1.5 size-3.5 shrink-0" aria-hidden="true" />
        {errorText(query.error)}
      </Message>
    );
  else if (!query.data) body = <Skeleton className="h-full w-full" />;
  else body = <Viz panel={panel} results={query.data} targets={targets} h={h} />;

  return (
    <section
      ref={ref}
      style={style}
      aria-label={panel.title || 'Panel'}
      className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card p-2.5 shadow-sm"
    >
      <header className="mb-1.5 flex h-5 shrink-0 items-center gap-1.5">
        <h3 className="truncate text-[13px] font-medium" title={panel.title}>
          {panel.title}
        </h3>
        {panel.description && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Info className="size-3.5" aria-hidden="true" />
                <span className="sr-only">About this panel</span>
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs whitespace-pre-line">{panel.description}</TooltipContent>
          </Tooltip>
        )}
        {query.isFetching && query.data && (
          <Loader2 className="ml-auto size-3 shrink-0 animate-spin text-muted-foreground" aria-label="Refreshing" />
        )}
        {query.isError && query.data && (
          <AlertTriangle className="ml-auto size-3 shrink-0 text-destructive" aria-label={errorText(query.error)} />
        )}
      </header>
      <div className="min-h-0 flex-1">{body}</div>
    </section>
  );
}
