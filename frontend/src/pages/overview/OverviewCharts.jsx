import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { ChartCard, TimeSeriesChart } from '@/components/app';
import { api, session } from '@/lib/api';
import { formatMs, formatPercent } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { buildHealthSeries, buildIncidentSeries, buildServerSeries } from './chart-data';

const MAX_SOURCES = 8; // keep the number of requests bounded on big accounts
const REFRESH = 60000;
const DAY_MS = 86400000;

const empty = (text) => (
  <p className="flex h-[200px] items-center justify-center px-4 text-center text-sm text-muted-foreground">
    {text}
  </p>
);

function useFanout(ids, path, params) {
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: [session.org, path(id), params],
      queryFn: () => api(path(id), { params }),
      retry: false,
      refetchInterval: REFRESH,
    })),
  });
  return {
    results,
    loading: ids.length > 0 && results.every((r) => r.isLoading),
    // Only an error when nothing at all could be loaded.
    error: ids.length > 0 && results.every((r) => r.isError) ? results[0].error : null,
    retry: () => results.forEach((r) => r.isError && r.refetch()),
  };
}

/** Uptime, latency, server CPU/memory and alert-rate charts built from existing endpoints. */
export default function OverviewCharts({ servers, websites }) {
  const siteIds = useMemo(() => websites.filter((w) => w.status !== 'paused').slice(0, MAX_SOURCES).map((w) => w.id), [websites]);
  const serverIds = useMemo(() => servers.slice(0, MAX_SOURCES).map((s) => s.id), [servers]);
  const since = useMemo(() => new Date(Date.now() - 7 * DAY_MS).toISOString().slice(0, 13) + ':00:00.000Z', []);

  const checks = useFanout(siteIds, (id) => `/websites/${id}/checks`, { range: '24h' });
  const metrics = useFanout(serverIds, (id) => `/servers/${id}/metrics`, { range: '24h' });
  const incidents = useApi('/alerts/incidents', { from: since, limit: 200 }, { retry: false, refetchInterval: REFRESH });

  const health = useMemo(
    () => buildHealthSeries(checks.results.map((r) => r.data).filter(Boolean)),
    [checks.results],
  );
  const usage = useMemo(
    () => buildServerSeries(metrics.results.map((r) => r.data).filter(Boolean)),
    [metrics.results],
  );
  const alertRate = useMemo(
    () => buildIncidentSeries(incidents.data?.items ?? [], 7),
    [incidents.data],
  );

  const noSites = siteIds.length === 0;
  const noServers = serverIds.length === 0;

  return (
    <section aria-label="Trends" className="mt-6 grid gap-4 lg:grid-cols-2">
      <ChartCard
        title="Uptime"
        description="Share of website checks that passed, last 24 hours"
        loading={checks.loading}
        error={checks.error}
        onRetry={checks.retry}
        empty={noSites ? empty('Add a website to see its uptime trend.') : health.length === 0 ? empty('No checks have run yet.') : null}
      >
        <TimeSeriesChart data={health} series={[{ key: 'uptime', label: 'Uptime' }]} format={(v) => formatPercent(v, 1)} domain={[0, 100]} />
      </ChartCard>
      <ChartCard
        title="Response time"
        description="Average website response, last 24 hours"
        loading={checks.loading}
        error={checks.error}
        onRetry={checks.retry}
        empty={noSites ? empty('Add a website to see how fast it answers.') : health.every((p) => p.latency == null) ? empty('No successful checks yet.') : null}
      >
        <TimeSeriesChart data={health} series={[{ key: 'latency', label: 'Average response' }]} format={formatMs} type="line" />
      </ChartCard>
      <ChartCard
        title="Server CPU and memory"
        description={`Average across ${serverIds.length} server${serverIds.length === 1 ? '' : 's'}, last 24 hours`}
        loading={metrics.loading}
        error={metrics.error}
        onRetry={metrics.retry}
        empty={noServers ? empty('Connect a server to see CPU and memory.') : usage.length === 0 ? empty('No readings yet. Servers report every minute.') : null}
      >
        <TimeSeriesChart
          data={usage}
          series={[{ key: 'cpu', label: 'CPU' }, { key: 'memory', label: 'Memory' }]}
          format={(v) => formatPercent(v)}
          domain={[0, 100]}
          type="line"
        />
      </ChartCard>
      <ChartCard
        title="Alerts and incidents"
        description="Alerts opened per day, last 7 days"
        loading={incidents.isLoading}
        error={incidents.error}
        onRetry={incidents.refetch}
        empty={alertRate.every((p) => p.opened === 0) ? empty('No alerts in the last 7 days. Nice.') : null}
      >
        <TimeSeriesChart
          data={alertRate}
          series={[{ key: 'opened', label: 'Opened' }, { key: 'critical', label: 'Critical' }]}
          format={(v) => String(Math.round(v))}
          type="line"
        />
      </ChartCard>
    </section>
  );
}
