import { Activity, Building2, CircleDollarSign, Globe, Server, Users } from 'lucide-react';
import {
  ChartCard,
  DataTable,
  ErrorState,
  PageHeader,
  StatCard,
  StatGridSkeleton,
  TimeSeriesChart,
} from '@/components/app';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatNumber } from '@/lib/format';
import { usePlatform } from './api';
import { formatCents } from './shared';

/** Horizontal bars for a few categories: one hue (magnitude), name and value in text colours. */
function Bars({ items, format = formatNumber, label }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="space-y-3" aria-label={label}>
      {items.map((item) => (
        <li key={item.key} title={`${item.label}: ${format(item.value)}`}>
          <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
            <span className="font-medium">{item.label}</span>
            <span className="tabular-nums text-muted-foreground">{format(item.value)}</span>
          </div>
          <div className="h-2 rounded-full bg-muted">
            <div
              className="h-2 rounded-full bg-primary transition-[width] duration-300"
              style={{ width: `${(item.value / max) * 100}%`, minWidth: item.value ? 4 : 0 }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

const QUEUE_COLUMNS = [
  { key: 'name', header: 'Queue', className: 'font-medium' },
  { key: 'waiting', header: 'Waiting', className: 'tabular-nums' },
  { key: 'active', header: 'Active', className: 'tabular-nums' },
  { key: 'delayed', header: 'Delayed', className: 'tabular-nums' },
  {
    key: 'failed',
    header: 'Failed',
    cell: (r) => (
      <span className={r.failed ? 'font-semibold text-destructive' : ''}>
        {formatNumber(r.failed)}
      </span>
    ),
  },
];

export default function AdminOverview() {
  const { data, isLoading, error, refetch } = usePlatform(
    '/overview',
    {},
    { refetchInterval: 60000 },
  );
  const planName = (id) => data?.orgsByPlan.find((p) => p.planId === id)?.name ?? id;
  return (
    <>
      <PageHeader
        title="Platform overview"
        description="Every organization on YuktiOps: growth, revenue and pipeline health."
      />
      {isLoading ? (
        <StatGridSkeleton count={5} />
      ) : error ? (
        <ErrorState title="Couldn't load the overview" error={error} onRetry={refetch} />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
            <StatCard
              label="Organizations"
              value={formatNumber(data.totals.orgs)}
              hint={
                data.totals.suspended
                  ? `${formatNumber(data.totals.suspended)} suspended`
                  : 'None suspended'
              }
              icon={Building2}
              to="/admin/orgs"
            />
            <StatCard
              label="Users"
              value={formatNumber(data.totals.users)}
              icon={Users}
              to="/admin/users"
              tone="info"
            />
            <StatCard
              label="Active agents"
              value={formatNumber(data.totals.activeAgents)}
              hint="Reported in the last 10 minutes"
              icon={Server}
              tone="success"
            />
            <StatCard
              label="Website checks"
              value={formatNumber(data.totals.monitors)}
              icon={Globe}
              tone="info"
            />
            <StatCard
              label="MRR"
              value={formatCents(data.mrrCents)}
              hint={
                data.comped
                  ? `+ ${formatCents(data.compedCents)} unbilled (${data.comped} comped or manual)`
                  : 'Billed through a payment provider'
              }
              icon={CircleDollarSign}
              tone="warning"
            />
          </div>

          <ChartCard
            title="Sign-ups"
            description="New organizations per day, last 30 days"
            empty={
              !data.signupsByDay.some((d) => d.count) && (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  No sign-ups in the last 30 days.
                </p>
              )
            }
          >
            <TimeSeriesChart
              data={data.signupsByDay.map((d) => ({ t: `${d.day}T00:00:00Z`, count: d.count }))}
              series={[{ key: 'count', label: 'Sign-ups' }]}
              format={(v) => formatNumber(Math.round(v))}
            />
          </ChartCard>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Organizations by plan</CardTitle>
                <CardDescription>Current subscription of every organization</CardDescription>
              </CardHeader>
              <CardContent>
                <Bars
                  label="Organizations by plan"
                  items={data.orgsByPlan.map((p) => ({
                    key: p.planId,
                    label: p.name,
                    value: p.count,
                  }))}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">MRR by plan</CardTitle>
                <CardDescription>
                  Monthly value of billed subscriptions, extra servers included (annual at 10/12)
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Bars
                  label="MRR by plan"
                  format={formatCents}
                  items={data.mrrByPlan
                    .filter((p) => p.planId !== 'free')
                    .map((p) => ({ key: p.planId, label: planName(p.planId), value: p.cents }))}
                />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Activity className="size-4 text-primary" aria-hidden="true" /> Pipeline health
                </CardTitle>
                <CardDescription>Queues, ingest lag and stored metric series</CardDescription>
              </div>
              <dl className="flex flex-wrap gap-6 text-sm">
                <div>
                  <dt className="text-muted-foreground">Ingest lag</dt>
                  <dd className="font-semibold tabular-nums">
                    {data.health.ingestLagSeconds === null
                      ? 'unknown'
                      : `${data.health.ingestLagSeconds.toFixed(1)} s`}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">VictoriaMetrics series</dt>
                  <dd className="font-semibold tabular-nums">
                    {data.health.vmSeries === null
                      ? 'unreachable'
                      : formatNumber(data.health.vmSeries)}
                  </dd>
                </div>
              </dl>
            </CardHeader>
            <CardContent>
              {data.health.error && (
                <p className="mb-3 text-sm text-destructive">{data.health.error}</p>
              )}
              <DataTable columns={QUEUE_COLUMNS} rows={data.health.queues} getKey={(r) => r.name} />
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
