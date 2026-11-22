import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie as RechartsPie,
  PieChart,
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
/** Series colour i (chart-1..5). Series past the fifth repeat the colours with a dashed stroke. */
export const seriesColor = (i) => COLORS[i % 5];
const dashFor = (i) => (i >= 5 ? (i >= 10 ? '2 3' : '6 3') : undefined);

function ChartTooltip({ active, payload, label, series, format }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md">
      <p className="mb-1 font-medium">{formatDateTime(label)}</p>
      {payload.map((item) => (
        <p key={item.dataKey} className="flex items-center gap-2">
          <span
            className="size-2 rounded-full"
            style={{ background: item.color }}
            aria-hidden="true"
          />
          <span className="max-w-[16rem] truncate text-muted-foreground">
            {series.find((s) => s.key === item.dataKey)?.label || item.name}
          </span>
          <span className="ml-auto pl-3 font-medium tabular-nums">{format(item.value)}</span>
        </p>
      ))}
    </div>
  );
}

/**
 * Time-series chart. data: [{ t: ISO string or ms, <key>: number }]. series: [{ key, label }]
 * (colours are chart-1..5 from the theme). `format` formats values (e.g. formatPercent).
 * `type`: 'area' (default) or 'line'. `domain` e.g. [0, 100]. `stacked` stacks areas,
 * `fillOpacity` (0..1) sets the area fill, `height` may be a number or '100%'.
 */
export function TimeSeriesChart({
  data,
  series,
  xKey = 't',
  type = 'area',
  format = String,
  domain,
  height = 240,
  stacked = false,
  fillOpacity = 0.15,
  hidden,
  animate = true,
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
            hidden?.has(s.key) ? null : type === 'line' ? (
              <Line
                key={s.key}
                dataKey={s.key}
                name={s.label}
                type="monotone"
                dot={false}
                strokeWidth={series.length > 5 ? 1.5 : 2}
                stroke={seriesColor(i)}
                strokeDasharray={dashFor(i)}
                isAnimationActive={animate}
              />
            ) : (
              <Area
                key={s.key}
                dataKey={s.key}
                name={s.label}
                type="monotone"
                strokeWidth={series.length > 5 ? 1.5 : 2}
                stroke={seriesColor(i)}
                strokeDasharray={dashFor(i)}
                fill={seriesColor(i)}
                fillOpacity={fillOpacity}
                stackId={stacked ? 'stack' : undefined}
                isAnimationActive={animate}
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

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const TRACK = 'hsl(var(--muted))';

/**
 * Grafana-style gauge: a 270° arc filled to `value` between `min` and `max`, coloured by
 * `color` (e.g. the matching threshold), with an optional outer ring of threshold bands.
 * thresholds: [{ value, color }] with CSS colours. `format` formats the centre value.
 */
export function Gauge({ value, min = 0, max = 100, color, thresholds, format = String, label }) {
  const has = value !== null && value !== undefined && Number.isFinite(Number(value));
  const ratio = has && max > min ? clamp01((Number(value) - min) / (max - min)) : 0;
  const bands =
    thresholds?.length > 0
      ? thresholds.map((t, i) => {
          const from = i === 0 || t.value == null ? min : Math.max(min, t.value);
          const to = i < thresholds.length - 1 ? Math.min(max, thresholds[i + 1].value ?? max) : max;
          return { v: Math.max(0, to - from), color: t.color };
        })
      : null;
  const fill = color || COLORS[0];
  return (
    <div className="relative h-full w-full" role="img" aria-label={`${label ? `${label}: ` : ''}${has ? format(value) : 'no data'}`}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
          {bands && (
            <RechartsPie
              data={bands}
              dataKey="v"
              startAngle={225}
              endAngle={-45}
              innerRadius="88%"
              outerRadius="96%"
              stroke="none"
              isAnimationActive={false}
            >
              {bands.map((b, i) => (
                <Cell key={i} fill={b.color} />
              ))}
            </RechartsPie>
          )}
          <RechartsPie
            data={[{ v: ratio }, { v: 1 - ratio }]}
            dataKey="v"
            startAngle={225}
            endAngle={-45}
            innerRadius={bands ? '64%' : '70%'}
            outerRadius={bands ? '84%' : '92%'}
            stroke="none"
            cornerRadius={3}
            isAnimationActive={false}
          >
            <Cell fill={fill} />
            <Cell fill={TRACK} />
          </RechartsPie>
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span className="font-serif text-xl font-semibold tabular-nums sm:text-2xl" style={{ color: has ? fill : undefined }}>
          {has ? format(value) : 'N/A'}
        </span>
      </div>
    </div>
  );
}

/**
 * Horizontal bar gauges, one per item: [{ label, value, color }]. Bars fill between min and max
 * (max defaults to the largest value). `format` formats the value shown at the end of each bar.
 */
export function BarGauge({ items, min = 0, max, format = String }) {
  const top = max ?? Math.max(...items.map((i) => Number(i.value) || 0), 1);
  return (
    <ul className="flex h-full flex-col justify-center gap-2 overflow-y-auto pr-1" aria-label="Values">
      {items.map((item, i) => {
        const has = item.value !== null && item.value !== undefined;
        const ratio = has && top > min ? clamp01((Number(item.value) - min) / (top - min)) : 0;
        const color = item.color || seriesColor(i);
        return (
          <li key={`${item.label}-${i}`} className="min-w-0">
            <div className="mb-0.5 flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate text-muted-foreground" title={item.label}>
                {item.label}
              </span>
              <span className="shrink-0 font-medium tabular-nums" style={{ color }}>
                {has ? format(item.value) : '-'}
              </span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${ratio * 100}%`, background: color }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Donut chart with a legend: items [{ label, value }] (colours chart-1..5). */
export function Pie({ items, format = String }) {
  const data = items.filter((i) => Number(i.value) > 0);
  const total = data.reduce((a, i) => a + Number(i.value), 0);
  return (
    <div className="flex h-full min-h-0 gap-3">
      <div className="min-w-0 flex-1" role="img" aria-label={data.map((d) => `${d.label} ${format(d.value)}`).join(', ')}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <RechartsPie data={data} dataKey="value" nameKey="label" innerRadius="55%" outerRadius="90%" stroke="hsl(var(--card))" strokeWidth={2} isAnimationActive={false}>
              {data.map((d, i) => (
                <Cell key={d.label} fill={seriesColor(i)} />
              ))}
            </RechartsPie>
            <Tooltip
              content={({ active, payload }) =>
                active && payload?.length ? (
                  <div className="rounded-xl border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md">
                    <span className="text-muted-foreground">{payload[0].name}</span>{' '}
                    <span className="font-medium tabular-nums">{format(payload[0].value)}</span>
                    {total > 0 && <span className="text-muted-foreground"> ({((payload[0].value / total) * 100).toFixed(1)}%)</span>}
                  </div>
                ) : null
              }
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="flex max-w-[45%] flex-col justify-center gap-1 overflow-y-auto text-xs">
        {data.map((d, i) => (
          <li key={d.label} className="flex min-w-0 items-center gap-1.5">
            <span className="size-2 shrink-0 rounded-full" style={{ background: seriesColor(i) }} aria-hidden="true" />
            <span className="truncate text-muted-foreground" title={d.label}>
              {d.label}
            </span>
            <span className="ml-auto pl-2 font-medium tabular-nums">{format(d.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
