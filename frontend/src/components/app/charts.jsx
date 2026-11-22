import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from './states';
import { formatDateTime } from '@/lib/format';

const COLORS = [1, 2, 3, 4, 5].map((n) => `hsl(var(--chart-${n}))`);

function ChartTooltip({ active, payload, label, series, format }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md">
      <p className="mb-1 font-medium">{formatDateTime(label)}</p>
      {payload.map((item, i) => (
        <p key={item.dataKey} className="flex items-center gap-2">
          <span
            className="size-2 rounded-full"
            style={{ background: item.color }}
            aria-hidden="true"
          />
          <span className="text-muted-foreground">{series[i]?.label || item.name}</span>
          <span className="ml-auto pl-3 font-medium tabular-nums">{format(item.value)}</span>
        </p>
      ))}
    </div>
  );
}

/**
 * Time-series chart. data: [{ t: ISO string or ms, <key>: number }]. series: [{ key, label }]
 * (colours are chart-1..5 from the theme). `format` formats values (e.g. formatPercent).
 * `type`: 'area' (default) or 'line'. `domain` e.g. [0, 100].
 */
export function TimeSeriesChart({
  data,
  series,
  xKey = 't',
  type = 'area',
  format = String,
  domain,
  height = 240,
}) {
  const Chart = type === 'line' ? LineChart : AreaChart;
  const axisProps = {
    tickLine: false,
    axisLine: false,
    tick: { fontSize: 12, fill: 'hsl(var(--muted-foreground))' },
  };
  return (
    <div
      style={{ height }}
      role="img"
      aria-label={`Chart of ${series.map((s) => s.label).join(', ')} over time`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <Chart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
          <XAxis
            dataKey={xKey}
            {...axisProps}
            minTickGap={48}
            tickFormatter={(v) => {
              const d = new Date(v);
              const span = data.length > 1 ? new Date(data[data.length - 1][xKey]) - new Date(data[0][xKey]) : 0;
              return span > 36 * 3600 * 1000
                ? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
                : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }}
          />
          <YAxis {...axisProps} width={56} domain={domain} tickFormatter={(v) => format(v)} />
          <Tooltip content={<ChartTooltip series={series} format={format} />} />
          {series.map((s, i) =>
            type === 'line' ? (
              <Line
                key={s.key}
                dataKey={s.key}
                name={s.label}
                type="monotone"
                dot={false}
                strokeWidth={2}
                stroke={COLORS[i % 5]}
              />
            ) : (
              <Area
                key={s.key}
                dataKey={s.key}
                name={s.label}
                type="monotone"
                strokeWidth={2}
                stroke={COLORS[i % 5]}
                fill={COLORS[i % 5]}
                fillOpacity={0.15}
              />
            ),
          )}
        </Chart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Card around a chart with loading / error / empty handling.
 * Props: title, description, actions (e.g. range tabs), loading, error, onRetry, empty (node shown when set).
 */
export function ChartCard({
  title,
  description,
  actions,
  loading,
  error,
  onRetry,
  empty,
  children,
  height = 240,
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {actions}
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton style={{ height }} className="w-full" />
        ) : error ? (
          <ErrorState title="Couldn't load this chart" error={error} onRetry={onRetry} />
        ) : empty ? (
          empty
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}
