import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  EmptyState,
  ErrorState,
  RelativeTime,
  StatusBadge,
  TableSkeleton,
  notify,
} from '@/components/app';
import { api, session } from '@/lib/api';
import { useSession } from '@/lib/session';
import { setIncidentState, useAction } from './api';

const STATE = {
  firing: { status: 'unhealthy', label: 'Open' },
  acknowledged: { status: 'warning', label: 'Seen, still open' },
  resolved: { status: 'healthy', label: 'Resolved' },
};

function Incident({ incident, canEdit }) {
  const action = useAction();
  const state = STATE[incident.state] || STATE.firing;
  const resourceLink =
    incident.resource?.kind === 'website'
      ? `/websites/${incident.resource.id}`
      : incident.resource?.kind === 'server'
        ? `/servers/${incident.resource.id}`
        : null;
  const change = (next, message) =>
    action.mutate(setIncidentState(incident.id, next), {
      onSuccess: () => notify.success(message),
    });
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={state.status} label={state.label} />
            <h2 className="font-medium">{incident.name}</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            {incident.resource?.name &&
              (resourceLink ? (
                <>
                  <Link to={resourceLink} className="underline">
                    {incident.resource.name}
                  </Link>
                  {' · '}
                </>
              ) : (
                `${incident.resource.name} · `
              ))}
            Started <RelativeTime value={incident.startedAt} />
            {incident.resolvedAt && (
              <>
                {' · '}Resolved <RelativeTime value={incident.resolvedAt} />
              </>
            )}
            {incident.valueText && ` · Reading: ${incident.valueText}`}
          </p>
        </div>
        {canEdit && incident.state !== 'resolved' && (
          <div className="flex shrink-0 gap-2">
            {incident.state === 'firing' && (
              <Button
                variant="outline"
                size="sm"
                disabled={action.isPending}
                onClick={() => change('acknowledged', 'Marked as seen')}
              >
                I've seen this
                <span className="sr-only">: {incident.name}</span>
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={action.isPending}
              onClick={() => change('resolved', 'Marked as resolved')}
            >
              Mark resolved
              <span className="sr-only">: {incident.name}</span>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function HistoryTab() {
  const { isAdmin } = useSession();
  const [filter, setFilter] = useState('open');
  const query = useInfiniteQuery({
    queryKey: [session.org, '/alerts/incidents', filter],
    queryFn: ({ pageParam }) =>
      api('/alerts/incidents', {
        params: { state: filter === 'all' ? '' : filter, limit: 25, before: pageParam || '' },
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextBefore || undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) || [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span id="history-filter" className="text-sm text-muted-foreground">
          Show
        </span>
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger aria-labelledby="history-filter" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Still open</SelectItem>
            <SelectItem value="resolved">Resolved</SelectItem>
            <SelectItem value="all">Everything</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {query.isLoading ? (
        <TableSkeleton rows={4} />
      ) : query.error ? (
        <ErrorState error={query.error} onRetry={query.refetch} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title={filter === 'open' ? 'Nothing needs you right now' : 'No alerts here yet'}
          text={
            filter === 'open'
              ? 'When something goes wrong it shows up here, and we also send it to your contacts.'
              : 'Past alerts will be listed here.'
          }
        />
      ) : (
        <>
          <ul className="space-y-3">
            {items.map((incident) => (
              <li key={incident.id}>
                <Incident incident={incident} canEdit={isAdmin} />
              </li>
            ))}
          </ul>
          {query.hasNextPage && (
            <div className="text-center">
              <Button
                variant="outline"
                onClick={() => query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
              >
                {query.isFetchingNextPage ? 'Loading…' : 'Show older'}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
