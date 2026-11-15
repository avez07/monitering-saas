import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Globe, Plus } from 'lucide-react';
import { Line, LineChart, ResponsiveContainer, YAxis } from 'recharts';
import { Card, CardContent } from '@/components/ui/card';
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
            strokeWidth={2}
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
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium tabular-nums">{children}</dd>
    </div>
  );
}

function SiteCard({ site }) {
  const info = siteStatus(site);
  const ssl = site.ssl ? expiry(site.ssl) : null;
  const domain = site.domain ? expiry(site.domain) : null;
  return (
    <Card className="transition-colors hover:bg-accent/50">
      <CardContent className="p-0">
        <Link
          to={`/websites/${site.id}`}
          className="flex flex-col gap-4 rounded-lg p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:flex-row lg:items-center"
        >
          <div className="min-w-0 lg:w-1/3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate font-semibold">{site.name}</h2>
              <StatusBadge status={info.status} label={info.label} />
            </div>
            <p className="truncate text-sm text-muted-foreground">
              {TYPE_LABELS[site.type]} ·{' '}
              {site.type === 'tcp' ? `${site.host}:${site.port}` : site.target}
            </p>
          </div>
          <dl className="grid flex-1 grid-cols-2 items-center gap-x-4 gap-y-3 sm:grid-cols-5">
            <Fact label="Uptime, last 24 hours">
              {site.uptime24h === null || site.uptime24h === undefined
                ? 'No data yet'
                : `${site.uptime24h}%`}
            </Fact>
            <Fact label="Response time">
              {site.latencyMs === null || site.latencyMs === undefined
                ? '–'
                : formatMs(site.latencyMs)}
            </Fact>
            <Fact label="Over the last day">
              <Sparkline id={site.id} />
            </Fact>
            <Fact label="SSL certificate">
              {site.type === 'tcp' ? 'Not used' : ssl?.text || 'Not available'}
            </Fact>
            <Fact label="Domain name">{domain?.text || 'Not available'}</Fact>
          </dl>
        </Link>
      </CardContent>
    </Card>
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
    <div>
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
        <div className="space-y-3">
          {sites.data.limits?.max ? (
            <p className="text-sm text-muted-foreground">
              {sites.data.limits.used} of {sites.data.limits.max} monitors used on your plan.
            </p>
          ) : null}
          <ul className="space-y-3">
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
