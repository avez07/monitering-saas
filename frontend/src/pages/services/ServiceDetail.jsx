import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Loader2, Trash2 } from 'lucide-react';
import {
  CardSkeleton,
  ConfirmDialog,
  ErrorState,
  PageHeader,
  RelativeTime,
  StatusBadge,
  notify,
} from '@/components/app';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAction, useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

const STATE = {
  running: { status: 'healthy', label: 'Running' },
  stopped: { status: 'unhealthy', label: 'Stopped' },
  failed: { status: 'unhealthy', label: 'Failed' },
  unknown: { status: 'unknown', label: 'Unknown' },
};
const EVENT = {
  appeared: 'First seen',
  stopped: 'Stopped',
  failed: 'Failed',
  recovered: 'Back to running',
};

export default function ServiceDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAdmin } = useSession();
  const { data, isLoading, error, refetch } = useApi(
    `/services/${id}`,
    {},
    {
      refetchInterval: (q) => (q.state.error?.status === 404 ? 5000 : 30000),
      retry: (count, e) => e.status !== 404 && count < 2,
    },
  );
  const action = useAction();
  const [confirm, setConfirm] = useState(false);
  const header = (title) => (
    <PageHeader
      title={title}
      breadcrumbs={[{ label: 'Services', to: '/services' }, { label: title }]}
    />
  );

  if (isLoading) return <CardSkeleton />;
  if (error?.status === 404)
    return (
      <>
        {header('Service')}
        <Alert role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          <AlertTitle>Waiting for first result…</AlertTitle>
          <AlertDescription>
            If you just added this service, the agent reports it within a minute. If it was
            removed, go back to{' '}
            <Link to="/services" className="underline underline-offset-4">
              your services
            </Link>
            .
          </AlertDescription>
        </Alert>
      </>
    );
  if (error)
    return <ErrorState title="We couldn't load this service" error={error} onRetry={refetch} />;

  const s = data;
  const state = STATE[s.state] || STATE.unknown;
  return (
    <>
      <PageHeader
        title={s.name}
        breadcrumbs={[{ label: 'Services', to: '/services' }, { label: s.name }]}
        actions={
          isAdmin && (
            <Button variant="outline" onClick={() => setConfirm(true)}>
              <Trash2 className="size-4" aria-hidden="true" /> Remove
            </Button>
          )
        }
      />
      <div className="space-y-6">
        <Card>
          <CardContent className="grid gap-4 p-5 sm:grid-cols-2">
            <div>
              <p className="text-sm text-muted-foreground">State</p>
              <StatusBadge status={state.status} label={state.label} />
              {s.detail && <p className="mt-1 text-sm text-muted-foreground">{s.detail}</p>}
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Runs on</p>
              {s.serverId ? (
                <Link to={`/servers/${s.serverId}`} className="underline-offset-4 hover:underline">
                  {s.serverName || 'Host'}
                </Link>
              ) : (
                <p>{s.serverName || 'Checked from outside'}</p>
              )}
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Type</p>
              <p>{s.kind || s.type}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Last checked</p>
              <RelativeTime value={s.lastChecked} />
              {s.responseMs != null && (
                <span className="text-sm text-muted-foreground"> · {s.responseMs} ms</span>
              )}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">History</CardTitle>
          </CardHeader>
          <CardContent>
            {s.events?.length ? (
              <ul className="divide-y">
                {s.events.map((e) => (
                  <li key={e.id} className="flex justify-between gap-3 py-2 text-sm">
                    <span>{e.message || EVENT[e.type] || e.type}</span>
                    <RelativeTime value={e.at} className="text-muted-foreground" />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing has changed yet.</p>
            )}
          </CardContent>
        </Card>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        destructive
        title={`Stop watching ${s.name}?`}
        description="We stop checking it and remove it from your list. Its history is removed too."
        confirmLabel="Remove"
        loading={action.isPending}
        onConfirm={() =>
          action.mutate(
            { path: `/services/${id}`, method: 'DELETE', quiet: true },
            {
              onSuccess: () => {
                notify.success('Removed');
                navigate('/services');
              },
            },
          )
        }
      />
    </>
  );
}
