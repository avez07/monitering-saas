import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search, Server, Server as ServerIcon } from 'lucide-react';
import {
  CardSkeleton,
  EmptyState,
  ErrorState,
  MetricBar,
  PageHeader,
  RelativeTime,
  StatusBadge,
} from '@/components/app';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useServers } from './api';
import { bySeverity, serverReason, serverStatus, statusLabel } from './status';

const STRIP = {
  healthy: 'bg-emerald-500',
  warning: 'bg-amber-500',
  unhealthy: 'bg-destructive',
  unknown: 'bg-muted-foreground/40',
};

function ServerCard({ server }) {
  const reason = serverReason(server);
  return (
    <Card className="surface card-accent relative h-full overflow-hidden transition-shadow duration-150 hover:shadow-md">
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 w-1 ${STRIP[serverStatus(server)] || STRIP.unknown}`}
      />
      <CardContent className="space-y-4 p-5 pl-6">
        <div className="flex items-start justify-between gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <ServerIcon className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-serif text-base font-semibold">
              <Link
                to={`/servers/${server.id}`}
                className="rounded-sm after:absolute after:inset-0 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {server.name}
              </Link>
              {server.kind === 'docker-host' && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">Docker host</span>
              )}
            </h2>
            <p className="truncate text-sm text-muted-foreground">
              {[server.os, server.agentVersion && `Agent ${server.agentVersion}`]
                .filter(Boolean)
                .join(' · ') || 'No details yet'}
            </p>
          </div>
          <StatusBadge status={serverStatus(server)} label={statusLabel(server)} />
        </div>
        <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-3 md:grid-cols-1 2xl:grid-cols-3">
          <MetricBar label="CPU" value={server.cpu} />
          <MetricBar label="Memory" value={server.memory} />
          <MetricBar label="Disk" value={server.disk} />
        </div>
        {reason && <p className="text-xs text-foreground/80">{reason}</p>}
        <p className="text-sm text-muted-foreground">
          Last seen {server.lastSeen ? <RelativeTime value={server.lastSeen} /> : 'never'}
        </p>
      </CardContent>
    </Card>
  );
}

export default function ServerList() {
  const [showDocker, setShowDocker] = useState(false);
  const { servers, isLoading, error, refetch } = useServers({ includeDockerHosts: showDocker });
  const [search, setSearch] = useState('');
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return servers
      .filter((s) => !q || [s.name, s.hostname, s.os].some((v) => v?.toLowerCase().includes(q)))
      .sort(bySeverity);
  }, [servers, search]);

  return (
    <>
      <PageHeader
        title="Servers"
        description="Every server you monitor, with the ones that need you shown first."
        actions={
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Switch
                id="show-docker-hosts"
                checked={showDocker}
                onCheckedChange={setShowDocker}
              />
              <label htmlFor="show-docker-hosts" className="text-sm">
                Show Docker hosts
              </label>
            </div>
            <Button asChild>
              <Link to="/add-server">
                <Plus className="size-4" aria-hidden="true" /> Add server
              </Link>
            </Button>
          </div>
        }
      />
      {isLoading ? (
        <div
          className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
          role="status"
          aria-label="Loading servers"
        >
          {[0, 1, 2].map((i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      ) : error ? (
        <ErrorState title="We couldn't load your servers" error={error} onRetry={refetch} />
      ) : servers.length === 0 ? (
        <EmptyState
          icon={Server}
          title="No servers yet"
          text="Install the small YuktiOps agent on a server and it shows up here within a minute."
          action={{ label: 'Add your first server', to: '/add-server' }}
        />
      ) : (
        <div className="space-y-4">
          <div className="relative w-full sm:max-w-sm">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              aria-label="Search servers"
              placeholder="Search by name or system"
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {shown.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">No server matches that search.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {shown.map((s) => (
                <li key={s.id} className="relative min-w-0">
                  <ServerCard server={s} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
