import { useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { Cpu, MemoryStick, RotateCcw, Server } from 'lucide-react';
import {
  ChartCard,
  ErrorState,
  LoadingState,
  PageHeader,
  RelativeTime,
  StatCard,
  StatusBadge,
  TimeSeriesChart,
} from '@/components/app';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useApi } from '@/lib/hooks';
import { formatBytes, formatDateTime, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import ContainerLogs from './ContainerLogs';

// Contract: docs/api/containers-services.md (detail, metrics), docs/api/advanced-telemetry.md §5 (logs).
const STATE = {
  running: { status: 'healthy', label: 'Running' },
  restarting: { status: 'warning', label: 'Restarting' },
  paused: { status: 'warning', label: 'Paused' },
  stopped: { status: 'unhealthy', label: 'Stopped' },
  exited: { status: 'unhealthy', label: 'Stopped' },
  created: { status: 'unknown', label: 'Not started' },
  removed: { status: 'unknown', label: 'Removed' },
};
const stateOf = (c) => STATE[c?.state] || { status: 'unknown', label: 'Unknown' };

const RANGES = [
  { key: '1h', label: '1 hour' },
  { key: '24h', label: '24 hours' },
  { key: '7d', label: '7 days' },
];

const tabClass = ({ isActive }) =>
  cn(
    'inline-flex items-center whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
  );

function RangePicker({ value, onChange }) {
  return (
    <div role="group" aria-label="Time range" className="flex flex-wrap gap-1">
      {RANGES.map((r) => (
        <Button
          key={r.key}
          type="button"
          size="sm"
          variant={value === r.key ? 'default' : 'outline'}
          aria-pressed={value === r.key}
          onClick={() => onChange(r.key)}
        >
          {r.label}
        </Button>
      ))}
    </div>
  );
}

const noData = (
  <p className="flex h-40 items-center justify-center text-center text-muted-foreground">No data in this time range yet.</p>
);

function Overview({ container }) {
  const [range, setRange] = useState('1h');
  const metrics = useApi(`/containers/${container.id}/metrics`, { range }, { refetchInterval: 60000 });
  const points = metrics.data?.points ?? [];
  const has = (key) => points.some((p) => p[key] !== null && p[key] !== undefined);
  const limit = container.memoryLimitBytes;
  const memPct = limit && container.memoryBytes != null ? (container.memoryBytes / limit) * 100 : null;
  const common = { loading: metrics.isLoading, error: metrics.error, onRetry: metrics.refetch };

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="CPU" value={formatPercent(container.cpuPercent, 1)} icon={Cpu} hint={container.state === 'running' ? 'Right now' : 'Not running'} />
        <StatCard
          label="Memory"
          value={formatBytes(container.memoryBytes, 0)}
          icon={MemoryStick}
          tone="info"
          hint={limit ? `${formatPercent(memPct)} of ${formatBytes(limit, 0)} limit` : 'No memory limit'}
        />
        <StatCard label="Restarts" value={container.restarts ?? 0} icon={RotateCcw} tone={container.restarts ? 'warning' : 'success'} />
        <StatCard
          label="Docker host"
          value={<span className="text-xl">{container.serverName || '-'}</span>}
          icon={Server}
          to={container.serverId ? `/servers/${container.serverId}` : undefined}
          hint={container.startedAt ? `Started ${formatDateTime(container.startedAt)}` : undefined}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Resource usage</h2>
        <RangePicker value={range} onChange={setRange} />
      </div>
      {metrics.data?.clamped && (
        <p className="text-sm text-muted-foreground">
          Your plan keeps a shorter history than this range. <Link to="/settings/plan" className="underline underline-offset-4">Upgrade for more</Link>.
        </p>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="CPU" description="Percent of one CPU core" {...common} empty={!has('cpu') ? noData : null}>
          <TimeSeriesChart
            data={points}
            series={[
              { key: 'cpu', label: range === '1h' ? 'CPU' : 'Average' },
              ...(range === '1h' ? [] : [{ key: 'cpuMax', label: 'Peak' }]),
            ]}
            type="line"
            format={(v) => formatPercent(v, 1)}
          />
        </ChartCard>
        <ChartCard title="Memory" description={limit ? `Limit ${formatBytes(limit, 0)}` : 'No memory limit set'} {...common} empty={!has('memoryBytes') ? noData : null}>
          <TimeSeriesChart
            data={points}
            series={[
              { key: 'memoryBytes', label: range === '1h' ? 'Used' : 'Average' },
              ...(range === '1h' ? [] : [{ key: 'memoryMaxBytes', label: 'Peak' }]),
              ...(has('memoryLimitBytes') ? [{ key: 'memoryLimitBytes', label: 'Limit' }] : []),
            ]}
            type="line"
            format={(v) => formatBytes(v, 0)}
          />
        </ChartCard>
      </div>

      <Card className="surface">
        <CardHeader>
          <CardTitle className="text-base">Recent events</CardTitle>
        </CardHeader>
        <CardContent>
          {container.events?.length ? (
            <ul className="divide-y">
              {container.events.map((e) => (
                <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm">
                  <span>{e.message || e.type}</span>
                  <RelativeTime value={e.at} className="text-muted-foreground" />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No events yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function ContainerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data: container, error, isLoading, refetch } = useApi(
    `/containers/${id}`,
    {},
    { refetchInterval: 30000, retry: (count, e) => e.status !== 404 && count < 2 },
  );

  if (isLoading) return <LoadingState label="Loading container…" />;
  if (error?.status === 404)
    return <ErrorState title="We can't find that container" error="It may have been removed." onRetry={() => navigate('/containers')} />;
  if (error) return <ErrorState title="We couldn't load this container" error={error} onRetry={refetch} />;

  const s = stateOf(container);
  return (
    <div className="page">
      <PageHeader
        title={container.name}
        description={[container.image, container.statusText].filter(Boolean).join(' · ')}
        breadcrumbs={[{ label: 'Containers', to: '/containers' }, { label: container.name }]}
        actions={<StatusBadge status={s.status} label={s.label} />}
      />
      <nav aria-label="Container sections" className="-mt-2 flex gap-1 overflow-x-auto pb-1">
        <NavLink to={`/containers/${id}`} end className={tabClass}>
          Overview
        </NavLink>
        <NavLink to={`/containers/${id}/logs`} className={tabClass}>
          Logs
        </NavLink>
      </nav>
      <Routes>
        <Route index element={<Overview container={container} />} />
        <Route path="logs" element={<ContainerLogs container={container} />} />
        <Route path="*" element={<Navigate to={`/containers/${id}`} replace />} />
      </Routes>
    </div>
  );
}
