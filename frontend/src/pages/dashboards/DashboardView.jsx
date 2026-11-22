import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useIsFetching, useQuery } from '@tanstack/react-query';
import { ChevronRight, Hourglass, RefreshCw } from 'lucide-react';
import { EmptyState, ErrorState } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { session } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useMediaQuery } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';
import { selectClass } from '@/pages/apps/shared';
import { listOf, queryInstant, retryPolicy, usePreset, useTargets } from './api';
import { LockedPreview } from './LockedPreview';
import { Panel } from './Panel';
import {
  DEFAULT_RANGE,
  GRID_GAP_PX,
  GRID_ROW_PX,
  RANGES,
  REFRESH,
  layoutPanels,
  rangeSeconds,
  refreshMs,
} from './model';

export const PRESET_ID = 'node-exporter-full';
const nowSec = () => Math.floor(Date.now() / 1000);
// "Ubuntu 24.04", "linux", "Debian"… count as Linux; only Windows and macOS do not.
const isLinux = (os) => !/windows|darwin|mac ?os/i.test(os || '');

/** Width of an element (callback ref), rounded to 50 px so small resizes do not change query steps. */
function useWidth() {
  const [el, setEl] = useState(null);
  const [width, setWidth] = useState(1200);
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width / 50) * 50;
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width];
}

/** Collapsed/expanded state per row title, remembered in this browser. */
function useRowState(presetId) {
  const key = `yuktiops.dashboard.${presetId}.rows`;
  const [state, setState] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(key) || '{}') || {};
    } catch {
      return {};
    }
  });
  const toggle = useCallback(
    (title, collapsed) =>
      setState((old) => {
        const next = { ...old, [title]: collapsed };
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* storage can be unavailable */
        }
        return next;
      }),
    [key],
  );
  return [state, toggle];
}

/** Container names reporting on this host (cAdvisor-style series). */
function useContainerNames(node, enabled) {
  return useQuery({
    queryKey: [session.org, 'dashboards', 'containers', node],
    queryFn: async () => {
      const result = await queryInstant({
        query: `group by (name) (container_last_seen{job="cadvisor", instance="${node}", name!=""})`,
        time: nowSec(),
      });
      return [...new Set(result.map((r) => r.metric?.name).filter(Boolean))].sort();
    },
    enabled: enabled && Boolean(node),
    staleTime: 60000,
    retry: retryPolicy,
  });
}

function Field({ id, label, children }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

function VariablesBar({ targets, fixedNode, node, setParam, container, containers, range, refresh, onRefresh, fetching, updatedAt }) {
  return (
    <div className="surface card-accent flex flex-wrap items-end gap-x-4 gap-y-3 p-4">
      {!fixedNode && (
        <Field id="v-node" label="Server">
          <select id="v-node" className={cn(selectClass, 'h-9 w-56 max-w-full')} value={node} onChange={(e) => setParam({ node: e.target.value })}>
            {targets.map((t) => (
              <option key={t.agentId} value={t.agentId}>
                {t.name || t.agentId}
                {t.hasData ? '' : ' (waiting for data)'}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field id="v-container" label="Container">
        <select
          id="v-container"
          className={cn(selectClass, 'h-9 w-48 max-w-full')}
          value={container}
          onChange={(e) => setParam({ container: e.target.value })}
        >
          <option value="">All containers</option>
          {containers.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          {container && !containers.includes(container) && <option value={container}>{container}</option>}
        </select>
      </Field>
      <div className="min-w-0 space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground" id="v-range">
          Time range
        </p>
        <div role="group" aria-labelledby="v-range" className="flex flex-wrap gap-1">
          {RANGES.map((r) => (
            <Button
              key={r.key}
              type="button"
              size="sm"
              variant={range === r.key ? 'default' : 'outline'}
              aria-pressed={range === r.key}
              onClick={() => setParam({ range: r.key })}
            >
              Last {r.label}
            </Button>
          ))}
        </div>
      </div>
      <Field id="v-refresh" label="Auto-refresh">
        <select id="v-refresh" className={cn(selectClass, 'h-9 w-24')} value={refresh} onChange={(e) => setParam({ refresh: e.target.value })}>
          {REFRESH.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="ml-auto flex items-center gap-3">
        {updatedAt && (
          <span className="text-xs text-muted-foreground" aria-live="polite">
            Updated {new Date(updatedAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        )}
        <Button type="button" size="sm" variant="outline" onClick={onRefresh} aria-label="Refresh now">
          <RefreshCw className={cn('size-4', fetching && 'animate-spin')} aria-hidden="true" /> Refresh
        </Button>
      </div>
    </div>
  );
}

function Row({ row, collapsed, onToggle, ctx, width, wide, onLocked }) {
  const panels = useMemo(() => layoutPanels(row.panels), [row.panels]);
  const id = `row-${row.title}`.replace(/\W+/g, '-');
  return (
    <section aria-labelledby={id}>
      {row.title && (
        <h2 className="mb-2">
          <button
            type="button"
            id={id}
            aria-expanded={!collapsed}
            onClick={() => onToggle(row.title, !collapsed)}
            className="flex w-full items-center gap-2 rounded-lg py-1.5 text-left text-sm font-semibold hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight className={cn('size-4 shrink-0 transition-transform duration-200', !collapsed && 'rotate-90')} aria-hidden="true" />
            {row.title}
            <span className="text-xs font-normal text-muted-foreground">
              {panels.length} panel{panels.length === 1 ? '' : 's'}
            </span>
          </button>
        </h2>
      )}
      {!collapsed && (
        <div
          className="grid"
          style={{
            gridTemplateColumns: wide ? 'repeat(24, minmax(0, 1fr))' : 'minmax(0, 1fr)',
            gridAutoRows: `${GRID_ROW_PX}px`,
            gap: `${GRID_GAP_PX}px`,
          }}
        >
          {panels.map((p) => (
            <Panel
              key={p.id}
              panel={p}
              ctx={ctx}
              h={p.grid.h}
              widthPx={wide ? (width * p.grid.w) / 24 : width}
              onLocked={onLocked}
              style={
                wide
                  ? { gridColumn: `${p.grid.x + 1} / span ${p.grid.w}`, gridRow: `${p.grid.y + 1} / span ${p.grid.h}` }
                  : { gridColumn: '1 / -1', gridRow: `span ${Math.max(p.grid.h, 5)}` }
              }
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Waiting({ os }) {
  if (!isLinux(os))
    return (
      <EmptyState
        icon={Hourglass}
        title="Advanced metrics need a Linux host"
        text={`This server runs ${os}. The advanced dashboard uses node_exporter metrics, which the agent collects on Linux hosts only.`}
      />
    );
  return (
    <EmptyState
      icon={Hourglass}
      title="Waiting for advanced metrics…"
      text="Linux hosts on Pro/Business; agent picks this up within a minute."
    />
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-2" role="status" aria-label="Loading dashboard">
      <Skeleton className="h-20 w-full" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-36" />
        ))}
      </div>
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

/**
 * The Grafana-like dashboard: variables bar plus collapsible rows of panels on a 24-column grid.
 * `fixedNode` pins $node (server detail "Advanced" tab) and hides the server picker; `server`
 * gives its OS for the "needs Linux" message.
 */
export default function DashboardView({ presetId = PRESET_ID, fixedNode, server }) {
  const { plan } = useSession();
  const entitled = Boolean(plan?.features?.advancedDashboard);
  const [locked, setLocked] = useState(false);
  const onLocked = useCallback(() => setLocked(true), []);

  const preset = usePreset(presetId, entitled && !locked);
  const targetsQuery = useTargets(entitled && !locked);
  const targets = listOf(targetsQuery.data);

  const [params, setParams] = useSearchParams();
  const setParam = useCallback(
    (patch) =>
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
      ),
    [setParams],
  );
  const range = RANGES.some((r) => r.key === params.get('range')) ? params.get('range') : DEFAULT_RANGE;
  const refresh = REFRESH.some((r) => r.key === params.get('refresh')) ? params.get('refresh') : 'off';
  const container = params.get('container') || '';
  const defaultNode = (targets.find((t) => t.hasData) || targets[0])?.agentId || '';
  const paramNode = params.get('node');
  const node = fixedNode || (targets.some((t) => t.agentId === paramNode) ? paramNode : defaultNode);
  const target = targets.find((t) => t.agentId === node);

  const [end, setEnd] = useState(nowSec);
  useEffect(() => setEnd(nowSec()), [range, node, container]);
  useEffect(() => {
    const ms = refreshMs(refresh);
    if (!ms) return undefined;
    const id = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) setEnd(nowSec());
    }, ms);
    return () => clearInterval(id);
  }, [refresh]);

  const hasData = Boolean(target?.hasData);
  const containersQuery = useContainerNames(node, entitled && !locked && hasData);
  const fetching = useIsFetching({ queryKey: [session.org, 'dashboards', 'panel'] }) > 0;
  const [rowState, toggleRow] = useRowState(presetId);
  const [gridRef, width] = useWidth();
  const wide = useMediaQuery('(min-width: 768px)');

  const ctx = useMemo(
    () => ({ node, nodename: target?.name || '', container, rangeSec: rangeSeconds(range), end }),
    [node, target?.name, container, range, end],
  );

  const blocked = [preset.error, targetsQuery.error, containersQuery.error].some((e) => e?.status === 402);
  if (!entitled || locked || blocked) return <LockedPreview />;
  if (preset.isPending || targetsQuery.isPending) return <DashboardSkeleton />;
  if (preset.error)
    return <ErrorState title="We couldn't load this dashboard" error={preset.error} onRetry={() => preset.refetch()} />;
  if (targetsQuery.error)
    return <ErrorState title="We couldn't load your hosts" error={targetsQuery.error} onRetry={() => targetsQuery.refetch()} />;
  if (!targets.length || (fixedNode && (!target || !hasData))) return <Waiting os={server?.os || target?.os} />;

  const rows = preset.data?.rows || [];
  return (
    <div className="space-y-4">
      <VariablesBar
        targets={targets}
        fixedNode={fixedNode}
        node={node}
        setParam={setParam}
        container={container}
        containers={containersQuery.data || []}
        range={range}
        refresh={refresh}
        onRefresh={() => setEnd(nowSec())}
        fetching={fetching}
        updatedAt={end}
      />
      {!hasData && <Waiting os={target?.os} />}
      <div ref={gridRef} className="space-y-4">
        {hasData && rows.map((row, i) => (
          <Row
            key={`${row.title}-${i}`}
            row={row}
            collapsed={row.title ? (rowState[row.title] ?? Boolean(row.collapsed)) : false}
            onToggle={toggleRow}
            ctx={ctx}
            width={width}
            wide={wide}
            onLocked={onLocked}
          />
        ))}
      </div>
    </div>
  );
}
