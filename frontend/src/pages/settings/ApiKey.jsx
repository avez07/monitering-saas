import { useState } from 'react';
import { Link } from 'react-router-dom';
import { KeyRound, TriangleAlert } from 'lucide-react';
import { ConfirmDialog, CopyField, ErrorState, RelativeTime, CardSkeleton } from '@/components/app';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useSession } from '@/lib/session';
import { createApiKey, getApiKey, regenerateApiKey, revokeApiKey, useCall, useDo } from './api';

export default function ApiKey() {
  const { isAdmin } = useSession();
  const query = useCall(['api-key'], getApiKey, { enabled: isAdmin });
  const [fresh, setFresh] = useState(null); // the raw key, shown once
  const [dialog, setDialog] = useState(null); // 'regenerate' | 'revoke'
  const [disconnect, setDisconnect] = useState(false);

  const create = useDo(createApiKey);
  const regenerate = useDo(regenerateApiKey, { success: 'New API key created.' });
  const revoke = useDo((disconnectServers) => revokeApiKey(disconnectServers), {
    success: (r) =>
      r?.disconnected
        ? `API key revoked. ${r.disconnected} server(s) disconnected.`
        : 'API key revoked.',
  });

  if (!isAdmin)
    return (
      <Alert>
        <AlertDescription>Only owners and admins can see or change the API key.</AlertDescription>
      </Alert>
    );
  if (query.isPending) return <CardSkeleton />;
  if (query.isError)
    return (
      <ErrorState
        title="We couldn't load the API key"
        error={query.error}
        onRetry={() => query.refetch()}
      />
    );

  const key = query.data?.key;
  const close = () => {
    setDialog(null);
    setDisconnect(false);
  };

  return (
    <div className="space-y-6">
      {fresh && (
        <Alert role="status">
          <TriangleAlert className="size-4" aria-hidden="true" />
          <AlertTitle>Copy your new API key now</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              This is the only time it is shown. Anyone with it can add servers to your account, so
              keep it private. If you lose it, create a new one.
            </p>
            <CopyField value={fresh} label="API key" />
            <Button variant="outline" size="sm" onClick={() => setFresh(null)}>
              I have saved it
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Account API key</CardTitle>
          <CardDescription>
            One key for your whole account. It is only used once per server, to connect it. Each
            server then gets its own credential.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {key ? (
            <>
              <dl className="grid gap-4 sm:grid-cols-3">
                <div>
                  <dt className="text-sm text-muted-foreground">Key starts with</dt>
                  <dd className="mt-1 font-mono text-sm">{key.prefix}…</dd>
                </div>
                <div>
                  <dt className="text-sm text-muted-foreground">Last used</dt>
                  <dd className="mt-1 text-sm">
                    {key.lastUsedAt ? <RelativeTime value={key.lastUsedAt} /> : 'Not used yet'}
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-muted-foreground">Connected servers</dt>
                  <dd className="mt-1 text-sm">{key.servers}</dd>
                </div>
              </dl>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setDialog('regenerate')}>
                  Regenerate key
                </Button>
                <Button variant="outline" onClick={() => setDialog('revoke')}>
                  Revoke key
                </Button>
                <Button asChild variant="ghost">
                  <Link to="/add-server">Add a server</Link>
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-start gap-3">
              <p className="text-base text-muted-foreground">
                You don&apos;t have an active API key. Create one to connect servers.
              </p>
              <Button
                disabled={create.isPending}
                onClick={() => create.mutate(undefined, { onSuccess: (r) => setFresh(r.key) })}
              >
                <KeyRound className="size-4" aria-hidden="true" />
                Create API key
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={dialog === 'regenerate'}
        onOpenChange={(open) => !open && close()}
        title="Regenerate the API key?"
        description="The old key stops working at once, so install commands that contain it will fail. Servers that are already connected keep running."
        confirmLabel="Regenerate"
        destructive
        loading={regenerate.isPending}
        onConfirm={() =>
          regenerate.mutate(undefined, {
            onSuccess: (r) => {
              setFresh(r.key);
              close();
            },
          })
        }
      />
      <ConfirmDialog
        open={dialog === 'revoke'}
        onOpenChange={(open) => !open && close()}
        title="Revoke the API key?"
        description={
          <span className="block space-y-4">
            <span className="block">
              No new servers can connect until you create another key. Connected servers keep
              running unless you also disconnect them.
            </span>
            <span className="flex items-start gap-2 text-foreground">
              <Checkbox
                id="disconnect-all"
                checked={disconnect}
                onCheckedChange={(v) => setDisconnect(v === true)}
              />
              <Label htmlFor="disconnect-all" className="font-normal leading-snug">
                Also disconnect all servers. They stop sending data until you set them up again.
              </Label>
            </span>
          </span>
        }
        confirmLabel="Revoke key"
        destructive
        loading={revoke.isPending}
        onConfirm={() => revoke.mutate(disconnect, { onSuccess: close })}
      />
    </div>
  );
}
