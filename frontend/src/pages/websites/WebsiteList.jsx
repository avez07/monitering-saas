import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Globe, Plus } from 'lucide-react';
import { Line, LineChart, ResponsiveContainer, YAxis } from 'recharts';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, PageHeader, StatusBadge, TableSkeleton } from '@/components/app';
import { useSession } from '@/lib/session';
import { formatMs } from '@/lib/format';
import { TYPE_LABELS, expiry, siteStatus, useChecks, useWebsites } from './api';
import WebsiteDialog from './WebsiteDialog';

function Sparkline({ id }) {
  const checks = useChecks(id, '24h');
  const data = (checks.data?.points || []).map((p) => ({ t: p.time, ms: p.avgLatencyMs }));
  if (data.length < 2) return <span className="text-sm text-muted-foreground">No data yet</span>;
  return (
    <div className="h-8 w-28" aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <YAxis hide domain={['dataMin', 'dataMax']} />
          <Line
            dataKey="ms"
            dot={false}
            strokeWidth={1.5}
            stroke="hsl(var(--chart-1))"
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function Fact({ label, children }) {
  return (
    <div className="min-w-0 rounded-xl bg-muted/60 px-3 py-2">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold tabular-nums">{children}</dd>
    </div>
  );
}

const STRIP = {
  up: 'bg-chart-2',
  healthy: 'bg-chart-2',
  down: 'bg-destructive',
  critical: 'bg-destructive',
  warning: 'bg-chart-4',
};

function SiteCard({ site }) {
  const info = siteStatus(site);
  const ssl = site.ssl ? expiry(site.ssl) : null;
  const domain = site.domain ? expiry(site.domain) : null;
  return (
    <div className="surface card-accent relative h-full overflow-hidden transition-shadow duration-150 hover:shadow-md">
      <span
        aria-hidden="true"
        className={`absolute inset-x-0 top-0 h-1 ${STRIP[info.status] || 'bg-primary/50'}`}
      />
      <Link
        to={`/websites/${site.id}`}
        className="flex h-full flex-col gap-4 rounded-2xl p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Globe className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-serif text-base font-semibold leading-tight">{site.name}</h2>
            <p className="truncate text-sm text-muted-foreground">
              {TYPE_LABELS[site.type]} ·{' '}
              {site.type === 'tcp' ? `${site.host}:${site.port}` : site.target}
            </p>
          </div>
          <StatusBadge status={info.status} label={info.label} />
        </div>
        <dl className="grid grid-cols-2 gap-2">
          <Fact label="Uptime, 24 hours">
            {site.uptime24h === null || site.uptime24h === undefined
              ? 'No data yet'
              : `${site.uptime24h}%`}
          </Fact>
          <Fact label="Response time">
            {site.latencyMs === null || site.latencyMs === undefined
              ? '–'
              : formatMs(site.latencyMs)}
          </Fact>
          <Fact label="SSL certificate">
            {site.type === 'tcp' ? 'Not used' : ssl?.text || 'Not available'}
          </Fact>
          <Fact label="Domain name">{domain?.text || 'Not available'}</Fact>
        </dl>
        <div className="mt-auto flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>Over the last day</span>
          <Sparkline id={site.id} />
        </div>
      </Link>
    </div>
  );
}

export default function WebsiteList() {
  const { isAdmin } = useSession();
  const [adding, setAdding] = useState(false);
  const sites = useWebsites({ refetchInterval: 30000 });

  const addButton = isAdmin ? (
    <Button onClick={() => setAdding(true)}>
      <Plus className="size-4" aria-hidden="true" />
      Add a website
    </Button>
  ) : null;

  return (
    <div className="page">
      <PageHeader
        title="Websites & APIs"
        description="We check your websites, APIs and ports from outside, around the clock. Nothing to install."
        actions={sites.data?.items.length ? addButton : null}
      />
      {sites.isLoading ? (
        <TableSkeleton rows={3} />
      ) : sites.error ? (
        <ErrorState error={sites.error} onRetry={sites.refetch} />
      ) : sites.data.items.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="Add your first website"
          text="Paste the address of your site. We check it from outside every few minutes and tell you if it goes down. No install needed, so it works on any hosting."
          action={
            isAdmin
              ? { label: 'Add your first website', onClick: () => setAdding(true) }
              : undefined
          }
        />
      ) : (
        <div className="space-y-4">
          {sites.data.limits?.max ? (
            <p className="text-sm text-muted-foreground">
              {sites.data.limits.used} of {sites.data.limits.max} monitors used on your plan.
            </p>
          ) : null}
          <ul className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {sites.data.items.map((site) => (
              <li key={site.id}>
                <SiteCard site={site} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {adding && <WebsiteDialog limits={sites.data?.limits} onClose={() => setAdding(false)} />}
    </div>
  );
}
