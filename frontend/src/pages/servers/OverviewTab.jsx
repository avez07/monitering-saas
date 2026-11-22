import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plug } from 'lucide-react';
import {
  ChartCard,
  DataTable,
  EmptyState,
  MetricBar,
  StatCard,
  TimeSeriesChart,
} from '@/components/app';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  formatBytes,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import { RANGES, useServerMetrics } from './api';

const rate = (v) => `${formatBytes(v)}/s`;
const axisBytes = (v) => formatBytes(v, 0);
const pct = (v) => formatPercent(v);
const load = (v) => (v === null || v === undefined ? '-' : Number(v).toFixed(2));

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

/** The mount shown as "the disk": the root mount, else the fullest one. */
function mainDisk(disks) {
  if (!disks?.length) return null;
  return disks.find((d) => d.path === '/') || [...disks].sort((a, b) => b.percent - a.percent)[0];
}

function Chart({
  title,
  description,
  points,
  series,
  format,
  domain,
  loading,
  error,
  refetch,
  type,
}) {
  const hasData = points.some((p) =>
    series.some((s) => p[s.key] !== null && p[s.key] !== undefined),
  );
  return (
    <ChartCard
      title={title}
      description={description}
      loading={loading}
      error={error}
      onRetry={refetch}
      empty={
        !hasData ? (
          <p className="flex h-40 items-center justify-center text-center text-muted-foreground">
            No data in this time range yet.
          </p>
        ) : null
      }
    >
      <TimeSeriesChart data={points} series={series} format={format} domain={domain} type={type} />
    </ChartCard>
  );
}

export default function OverviewTab({ server }) {
  const [range, setRange] = useState('24h');
  const metrics = useServerMetrics(server.id, range);
  const points = useMemo(() => metrics.data?.points ?? [], [metrics.data]);
  const hasLoad5 = points.some((p) => p.load5 !== null && p.load5 !== undefined);

  if (server.status === 'never_connected')
    return (
      <EmptyState
        icon={Plug}
        title="Waiting for the first data"
        text="This server is registered but hasn't sent anything yet. The Connection tab shows what's happening and how to fix it."
        action={{ label: 'Open connection steps', to: `/servers/${server.id}/connection` }}
      />
    );

  const latest = server.latest;
  const disk = mainDisk(server.disks);
  const free = disk ? formatBytes(disk.totalBytes - disk.usedBytes, 0) : null;
  const chartProps = {
    points,
    loading: metrics.isLoading,
    error: metrics.error,
    refetch: metrics.refetch,
  };

  return (
    <div className="space-y-6">
      {server.status === 'offline' && (
        <p className="rounded-lg border border-destructive/50 p-4 text-sm" role="status">
          <strong>This server is down.</strong> We last heard from it{' '}
          {server.lastSeen ? formatDateTime(server.lastSeen) : 'never'}. The numbers below are the
          last ones we received.{' '}
          <Link
            to={`/servers/${server.id}/connection`}
            className="font-medium underline underline-offset-4"
          >
            Open connection steps
          </Link>
        </p>
      )}

      <section aria-label="Right now" className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-4">
        <StatCard
          label="CPU"
          value={formatPercent(server.cpu)}
          hint={server.cores ? `${server.cores} cores` : undefined}
        />
        <StatCard
          label="Memory"
          value={formatPercent(server.memory)}
          hint={
            server.ramGb
              ? `of ${server.ramGb} GB${latest?.swap ? ` · swap ${formatPercent(latest.swap)}` : ''}`
              : undefined
          }
        />
        <StatCard
          label="Disk"
          value={formatPercent(server.disk)}
          hint={disk ? `${formatPercent(disk.percent)} used · ${free} free` : undefined}
        />
        <StatCard
          label="Uptime"
          value={formatDuration(server.uptimeSeconds)}
          hint="since the last restart"
        />
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-serif text-base font-semibold tracking-tight">History</h2>
        <RangePicker value={range} onChange={setRange} />
      </div>
      {metrics.data?.clamped && (
        <p className="text-sm text-muted-foreground">
          Your plan keeps a limited history, so this chart starts on{' '}
          {formatDateTime(metrics.data.from)}.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Chart
          {...chartProps}
          title="CPU"
          description="How busy the processor is"
          series={[{ key: 'cpu', label: 'CPU' }]}
          format={pct}
          domain={[0, 100]}
        />
        <Chart
          {...chartProps}
          title="Memory"
          description="Memory and swap in use"
          series={[
            { key: 'memory', label: 'Memory' },
            { key: 'swap', label: 'Swap' },
          ]}
          format={pct}
          domain={[0, 100]}
          type="line"
        />
        <Chart
          {...chartProps}
          title="Load"
          description="How many tasks are waiting for the processor"
          series={
            hasLoad5
              ? [
                  { key: 'load1', label: '1 minute' },
                  { key: 'load5', label: '5 minutes' },
                  { key: 'load15', label: '15 minutes' },
                ]
              : [{ key: 'load1', label: '1 minute' }]
          }
          format={load}
          type="line"
        />
        <Chart
          {...chartProps}
          title="Disk used"
          description="Share of the main disk that is full"
          series={[{ key: 'disk', label: 'Disk used' }]}
          format={pct}
          domain={[0, 100]}
        />
        <Chart
          {...chartProps}
          title="Network"
          description="Data received and sent, per second"
          series={[
            { key: 'netRxBps', label: 'Received' },
            { key: 'netTxBps', label: 'Sent' },
          ]}
          format={axisBytes}
          type="line"
        />
        <Chart
          {...chartProps}
          title="Disk activity"
          description="Data read from and written to disk, per second"
          series={[
            { key: 'diskReadBps', label: 'Read' },
            { key: 'diskWriteBps', label: 'Written' },
          ]}
          format={axisBytes}
          type="line"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="font-serif text-base font-semibold tracking-tight">Disk space by drive</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {server.disks?.length ? (
              server.disks.map((d) => (
                <MetricBar
                  key={d.path}
                  label={d.path}
                  value={d.percent}
                  detail={`${formatBytes(d.totalBytes - d.usedBytes, 0)} free of ${formatBytes(d.totalBytes, 0)}`}
                />
              ))
            ) : (
              <p className="text-muted-foreground">No drive information yet.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="font-serif text-base font-semibold tracking-tight">Network cards</CardTitle>
          </CardHeader>
          <CardContent>
            {server.interfaces?.length ? (
              <ul className="divide-y">
                {server.interfaces.map((n) => (
                  <li key={n.name} className="flex justify-between gap-3 py-2 text-sm">
                    <span className="font-medium">{n.name}</span>
                    <span className="tabular-nums text-muted-foreground">
                      In {rate(n.rxBps)} · Out {rate(n.txBps)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">No network information yet.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <section aria-labelledby="procs">
        <h2 id="procs" className="mb-3 font-serif text-base font-semibold tracking-tight">
          Busiest programs
        </h2>
        <DataTable
          rows={server.processes ?? []}
          getKey={(p) => `${p.pid}-${p.name}`}
          empty={
            <p className="surface border-dashed p-8 text-center text-muted-foreground">
              No program information. It may be switched off in this server's settings.
            </p>
          }
          columns={[
            { key: 'name', header: 'Program', className: 'font-medium' },
            { key: 'pid', header: 'ID', className: 'tabular-nums' },
            {
              key: 'cpu',
              header: 'CPU',
              className: cn('tabular-nums'),
              cell: (p) => formatPercent(p.cpu, 1),
            },
            {
              key: 'memBytes',
              header: 'Memory',
              className: 'tabular-nums',
              cell: (p) => formatBytes(p.memBytes, 0),
            },
          ]}
        />
        <p className="mt-2 text-sm text-muted-foreground">
          {formatNumber(server.processes?.length ?? 0)} shown, sorted by what uses the most.
        </p>
      </section>
    </div>
  );
}
