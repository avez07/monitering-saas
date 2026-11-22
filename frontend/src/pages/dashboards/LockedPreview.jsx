import { Link } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { Gauge, TimeSeriesChart } from '@/components/app/charts';
import { Button } from '@/components/ui/button';
import { formatValue } from './model';

// Static sample data only: the locked preview never calls the API.
const now = 1_700_000_000_000;
const wave = (n, base, amp, phase = 0) =>
  Array.from({ length: n }, (_, i) => base + amp * Math.sin(i / 4 + phase) + amp * 0.3 * Math.sin(i * 1.7));
const cpu = wave(48, 38, 14);
const mem = wave(48, 62, 6, 1);
const net = wave(48, 4e6, 2e6, 2);
const data = cpu.map((c, i) => ({ t: now + i * 60000, s0: c, s1: mem[i], s2: Math.abs(net[i]) }));

const GAUGES = [
  { label: 'CPU Busy', value: 42, color: 'hsl(var(--success))' },
  { label: 'Sys Load', value: 23, color: 'hsl(var(--success))' },
  { label: 'RAM Used', value: 67, color: 'hsl(var(--warning))' },
  { label: 'SWAP Used', value: 4, color: 'hsl(var(--success))' },
  { label: 'Root FS Used', value: 91, color: 'hsl(var(--destructive))' },
];

function SamplePanel({ title, className, children }) {
  return (
    <div className={`flex flex-col rounded-xl border border-border/70 bg-card p-2.5 shadow-sm ${className}`}>
      <p className="mb-1.5 text-[13px] font-medium">{title}</p>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

/** Blurred sample of the advanced dashboard with an "Upgrade to Pro" call to action. */
export function LockedPreview() {
  const pct = (v) => formatValue(v, 'percent', 0);
  return (
    <div className="relative overflow-hidden rounded-2xl">
      <div aria-hidden="true" className="pointer-events-none select-none blur-[3px] saturate-75" inert>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {GAUGES.map((g) => (
            <SamplePanel key={g.label} title={g.label} className="h-36">
              <Gauge value={g.value} color={g.color} format={pct} />
            </SamplePanel>
          ))}
        </div>
        <div className="mt-2 grid gap-2 lg:grid-cols-2">
          <SamplePanel title="CPU Basic" className="h-64">
            <TimeSeriesChart data={data} series={[{ key: 's0', label: 'Busy' }]} format={pct} height="100%" animate={false} />
          </SamplePanel>
          <SamplePanel title="Memory Basic" className="h-64">
            <TimeSeriesChart data={data} series={[{ key: 's1', label: 'Used' }]} format={pct} height="100%" animate={false} />
          </SamplePanel>
          <SamplePanel title="Network Traffic Basic" className="h-64 lg:col-span-2">
            <TimeSeriesChart
              data={data}
              series={[{ key: 's2', label: 'eth0 - Rx in' }]}
              format={(v) => formatValue(v, 'bps')}
              height="100%"
              animate={false}
            />
          </SamplePanel>
        </div>
      </div>
      <div className="absolute inset-0 flex items-center justify-center bg-background/40 p-4">
        <div className="surface card-accent max-w-md p-6 text-center">
          <span className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Lock className="size-5" aria-hidden="true" />
          </span>
          <h2 className="text-lg font-semibold">Advanced dashboards are on Pro and Business</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            See the full Node Exporter view of every Linux host: per-core CPU, memory internals, disk I/O, network,
            sockets and containers, with 30 days of history.
          </p>
          <Button asChild className="mt-5">
            <Link to="/settings/plan">Upgrade to Pro</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
