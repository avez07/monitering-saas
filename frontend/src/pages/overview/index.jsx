import { Link } from 'react-router-dom';
import { Bell, CheckCircle2, Globe, Plus, Server } from 'lucide-react';
import {
  EmptyState,
  ErrorState,
  PageHeader,
  RelativeTime,
  StatCard,
  StatGridSkeleton,
  StatusBadge,
} from '@/components/app';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/hooks';
import { useServers } from '@/pages/servers/api';
import { bySeverity, serverReason, serverStatus, statusLabel } from '@/pages/servers/status';

const items = (data) => (Array.isArray(data) ? data : (data?.items ?? []));
const optional = { retry: false, refetchInterval: 30000 };

const SEVERITY_WORD = { critical: 'Critical', warning: 'Warning', info: 'Note' };

function attentionItems(servers, websites, incidents) {
  const list = [];
  for (const s of servers.slice().sort(bySeverity)) {
    const status = serverStatus(s);
    if (status === 'healthy') continue;
    list.push({
      key: `server-${s.id}`,
      status,
      label: statusLabel(s),
      title: s.name,
      text: serverReason(s),
      to: `/servers/${s.id}${status === 'warning' ? '' : '/connection'}`,
      cta: status === 'warning' ? 'Open server' : 'See why',
    });
  }
  for (const w of websites) {
    if (w.status !== 'down') continue;
    list.push({
      key: `site-${w.id}`,
      status: 'unhealthy',
      label: 'Down',
      title: w.name,
      text: w.lastError ? `Not answering: ${w.lastError}` : 'This website is not answering.',
      to: `/websites/${w.id}`,
      cta: 'Open website',
    });
  }
  for (const i of incidents) {
    if (i.state !== 'firing') continue;
    list.push({
      key: `alert-${i.id}`,
      status: i.severity === 'critical' ? 'unhealthy' : 'warning',
      label: i.severity === 'critical' ? 'Critical' : 'Needs attention',
      title: i.name,
      text: i.valueText ? `Currently ${i.valueText}.` : null,
      to: '/alerts',
      cta: 'View alert',
    });
  }
  return list;
}

function AttentionList({ list, loading }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">What needs attention</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3" role="status" aria-label="Loading">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : list.length === 0 ? (
          <p className="flex items-center gap-3 py-4 text-base">
            <CheckCircle2 className="size-6 shrink-0 text-chart-2" aria-hidden="true" />
            Everything looks good. Nothing needs your attention right now.
          </p>
        ) : (
          <ul className="divide-y">
            {list.map((item) => (
              <li
                key={item.key}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={item.status} label={item.label} />
                    <span className="font-medium">{item.title}</span>
                  </div>
                  {item.text && <p className="text-sm text-muted-foreground">{item.text}</p>}
                </div>
                <Button asChild variant="outline" size="sm" className="shrink-0 self-start">
                  <Link to={item.to}>{item.cta}</Link>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function RecentAlerts({ summary }) {
  const recent = summary?.recent ?? [];
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-lg">Recent alerts</CardTitle>
        <Button asChild variant="link" size="sm">
          <Link to="/alerts">See all</Link>
        </Button>
      </CardHeader>
      <CardContent>
        {recent.length === 0 ? (
          <p className="text-muted-foreground">
            No alerts yet. We'll list them here when they happen.
          </p>
        ) : (
          <ul className="divide-y">
            {recent.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0">
                  <p className="font-medium">{i.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {SEVERITY_WORD[i.severity] || 'Alert'} ·{' '}
                    {i.state === 'resolved'
                      ? 'Resolved'
                      : i.state === 'acknowledged'
                        ? 'Acknowledged'
                        : 'Open'}{' '}
                    · <RelativeTime value={i.startedAt} />
                  </p>
                </div>
                <StatusBadge
                  status={
                    i.state === 'resolved'
                      ? 'healthy'
                      : i.state === 'firing'
                        ? 'unhealthy'
                        : 'warning'
                  }
                  label={
                    i.state === 'resolved'
                      ? 'Resolved'
                      : i.state === 'firing'
                        ? 'Open'
                        : 'Acknowledged'
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default function Overview() {
  const serversQuery = useServers();
  const websitesQuery = useApi('/websites', {}, optional);
  const alertsQuery = useApi('/alerts/summary', {}, optional);
  const { servers, isLoading, error, refetch } = serversQuery;
  const websites = items(websitesQuery.data);
  const summary = alertsQuery.data;
  const incidents = summary?.recent ?? [];

  if (error)
    return (
      <>
        <PageHeader title="Overview" />
        <ErrorState title="We couldn't load your overview" error={error} onRetry={refetch} />
      </>
    );

  const settling = isLoading || websitesQuery.isLoading;
  if (!settling && servers.length === 0 && websites.length === 0)
    return (
      <>
        <PageHeader title="Overview" />
        <EmptyState
          icon={Server}
          title="Let's get your first server connected"
          text="Install the small YuktiOps agent and you'll see CPU, memory, disk and alerts here within a minute."
          action={{ label: 'Add your first server', to: '/add-server' }}
        />
        <p className="mt-4 text-center text-muted-foreground">
          Running an app instead?{' '}
          <Link to="/apps/connect" className="font-medium text-foreground underline underline-offset-4">
            Connect your app with OpenTelemetry
          </Link>
        </p>
        <p className="mt-2 text-center text-muted-foreground">
          No server to install on?{' '}
          <Link to="/websites" className="font-medium text-foreground underline underline-offset-4">
            Monitor a website instead
          </Link>
        </p>
      </>
    );

  const counts = { healthy: 0, warning: 0, unhealthy: 0, unknown: 0 };
  servers.forEach((s) => counts[serverStatus(s)]++);
  const sitesDown = websites.filter((w) => w.status === 'down').length;
  const sitesUp = websites.filter((w) => w.status === 'up').length;
  const open = (summary?.firing ?? 0) + (summary?.acknowledged ?? 0);
  const attention = attentionItems(servers, websites, incidents);

  return (
    <>
      <PageHeader
        title="Overview"
        description="How everything is doing right now."
        actions={
          <Button asChild>
            <Link to="/add-server">
              <Plus className="size-4" aria-hidden="true" /> Add server
            </Link>
          </Button>
        }
      />
      {settling ? (
        <StatGridSkeleton />
      ) : (
        <section aria-label="Summary" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Servers"
            icon={Server}
            to="/servers"
            value={`${counts.healthy} of ${servers.length}`}
            hint={
              servers.length === counts.healthy
                ? 'All healthy'
                : `${counts.unhealthy} down · ${counts.warning} need attention${counts.unknown ? ` · ${counts.unknown} waiting` : ''}`
            }
          />
          <StatCard
            label="Websites"
            icon={Globe}
            to="/websites"
            value={websites.length ? `${sitesUp} of ${websites.length} up` : 'None yet'}
            hint={
              websites.length
                ? sitesDown
                  ? `${sitesDown} down`
                  : 'None down'
                : 'Add one to watch it from outside'
            }
          />
          <StatCard
            label="Open alerts"
            icon={Bell}
            to="/alerts"
            value={open}
            hint={open ? `${summary?.firing ?? 0} need you now` : 'No open alerts'}
          />
          <StatCard
            label="Needs attention"
            icon={CheckCircle2}
            value={attention.length}
            hint={attention.length ? 'See the list below' : 'Nothing to do'}
          />
        </section>
      )}

      <div className="mt-6 grid gap-6 xl:grid-cols-[3fr_2fr]">
        <AttentionList list={attention} loading={settling} />
        <RecentAlerts summary={summary} />
      </div>
    </>
  );
}
