import { Link } from 'react-router-dom';
import { Plug } from 'lucide-react';
import { EmptyState, ErrorState } from '@/components/app';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { RANGES } from './api';
import { appStatus } from './model';
import { statusInfo } from '@/lib/status';

export const selectClass =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** Labelled native select. options: [{ value, label }] */
export function SelectField({ id, label, value, onChange, options, className }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      <select id={id} className={selectClass} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export const RangeSelect = ({ value, onChange, id = 'range' }) => (
  <SelectField id={id} label="Time range" value={value} onChange={onChange} options={RANGES} />
);

/** Service status as dot + word. */
export function AppStatus({ status }) {
  const info = appStatus(status);
  const s = statusInfo(info.key);
  return (
    <Badge variant="outline" className="gap-1.5 whitespace-nowrap py-0.5 text-xs font-medium">
      <span className={cn('size-1.5 rounded-full', s.dot)} aria-hidden="true" />
      {info.label}
    </Badge>
  );
}

/** Shown when the app has no telemetry yet: one next action. */
export function NoDataState({ what = 'traces' }) {
  return (
    <EmptyState
      icon={Plug}
      title={`No ${what} yet`}
      text="Connect an app with the OpenTelemetry SDK and it will show up here within a minute."
      action={{ label: 'Connect your app', to: '/apps/connect' }}
    />
  );
}

/** Storage-down and other errors with a plain message. */
export function QueryError({ query, title }) {
  return (
    <ErrorState
      title={title}
      error={
        query.error?.status === 503
          ? 'Telemetry storage is unavailable. Try again shortly.'
          : query.error
      }
      onRetry={() => query.refetch()}
    />
  );
}

export const TraceLink = ({ id, children }) => (
  <Link
    to={`/apps/traces/${id}`}
    className="rounded-sm font-mono text-sm underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    {children ?? id.slice(0, 8)}
  </Link>
);

/** Tiny request-rate sparkline (decorative: the numbers beside it carry the meaning). */
export function Sparkline({ points = [], dataKey = 'requests', className }) {
  const values = points.map((p) => Number(p[dataKey]) || 0);
  const max = Math.max(...values, 1);
  if (values.length < 2) return <span className="text-muted-foreground">-</span>;
  const d = values
    .map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * 100).toFixed(1)},${(22 - (v / max) * 20).toFixed(1)}`)
    .join(' ');
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" className={cn('h-6 w-24 text-chart-2', className)} aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
