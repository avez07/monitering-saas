import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Loader2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog, CopyField, ErrorState, FormField } from '@/components/app';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { session } from '@/lib/api';
import { createApiKey, getApiKey, regenerateApiKey } from './api';
import { KEY_PATTERN } from './model';

/**
 * Account API key handling (PLAN 3.1). Reports the usable key through `onKey(string | '')`:
 * a freshly created one (shown once) or one the person pasted.
 */
export default function KeyPanel({ keyValue, onKey }) {
  const client = useQueryClient();
  const existing = useQuery({
    queryKey: [session.org, 'add-server', 'api-key'],
    queryFn: getApiKey,
    retry: false,
  });
  const [fresh, setFresh] = useState(false); // the key in `keyValue` was just created (show once)
  const [confirm, setConfirm] = useState(false);

  const issue = useMutation({
    mutationFn: (regenerate) => (regenerate ? regenerateApiKey() : createApiKey()),
    onSuccess: (row) => {
      client.invalidateQueries({ queryKey: [session.org, 'add-server', 'api-key'] });
      setFresh(true);
      setConfirm(false);
      onKey(row.key);
    },
    onError: (error) => toast.error(error.message),
  });

  if (existing.isPending)
    return <p className="text-sm text-muted-foreground">Checking your API key…</p>;
  if (existing.isError)
    return (
      <ErrorState
        title="We couldn't check your API key"
        error={existing.error}
        onRetry={() => existing.refetch()}
      />
    );

  if (fresh && keyValue)
    return (
      <Alert role="status">
        <TriangleAlert className="size-4" aria-hidden="true" />
        <AlertTitle>Your API key (shown only once)</AlertTitle>
        <AlertDescription className="space-y-3">
          <CopyField value={keyValue} label="API key" />
          <p>
            It is already filled into the commands below. Copy it somewhere safe: we cannot show it
            again, and anyone with it can add servers to your account.
          </p>
        </AlertDescription>
      </Alert>
    );

  const prefix = existing.data?.prefix;
  const invalid = keyValue && !KEY_PATTERN.test(keyValue);

  if (!existing.data)
    return (
      <div className="space-y-3 rounded-lg border bg-card p-4">
        <p className="font-medium">First, create your API key</p>
        <p className="text-sm text-muted-foreground">
          The key lets servers join your account. You only need one for all your servers.
        </p>
        <Button disabled={issue.isPending} onClick={() => issue.mutate(false)}>
          {issue.isPending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <KeyRound className="size-4" aria-hidden="true" />
          )}
          Create API key
        </Button>
      </div>
    );

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <FormField
        label="Your API key"
        hint={`Starts with yk_live_ (yours begins ${prefix}). We can't show it again after it was created.`}
        error={invalid ? 'That does not look like a full API key.' : undefined}
      >
        {(p) => (
          <Input
            {...p}
            value={keyValue}
            onChange={(e) => onKey(e.target.value.trim())}
            placeholder="yk_live_…"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        )}
      </FormField>
      <Button variant="link" className="h-auto p-0" onClick={() => setConfirm(true)}>
        Lost it? Regenerate
      </Button>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Regenerate your API key?"
        description="The old key stops working for new installs. Servers that are already connected keep running."
        confirmLabel="Regenerate"
        destructive
        loading={issue.isPending}
        onConfirm={() => issue.mutate(true)}
      />
    </div>
  );
}
