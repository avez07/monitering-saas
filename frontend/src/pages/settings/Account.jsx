import { useState } from 'react';
import { CircleCheck, MailWarning } from 'lucide-react';
import { ConfirmDialog, FormField } from '@/components/app';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useSession } from '@/lib/session';
import { logoutAll, renameOrg, requestPasswordReset, resendVerification, useDo } from './api';

function Verification({ user }) {
  const resend = useDo(resendVerification, {
    success: (r) =>
      r?.alreadyVerified ? 'Your email is already verified.' : 'Verification email sent.',
  });
  if (user.emailVerified)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <CircleCheck className="size-4" aria-hidden="true" /> Email verified
      </p>
    );
  return (
    <Alert>
      <MailWarning className="size-4" aria-hidden="true" />
      <AlertTitle>Your email is not verified yet</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>
          We sent a link to {user.email}. Verifying keeps your account safe and lets us reach you if
          a server goes down. Everything works in the meantime.
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={resend.isPending}
          onClick={() => resend.mutate()}
        >
          Send the link again
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function Organization({ organization, isAdmin }) {
  const [name, setName] = useState(organization?.name || '');
  const rename = useDo((value) => renameOrg(value), { success: 'Organization renamed.' });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Organization</CardTitle>
        <CardDescription>The name your team sees.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            rename.mutate(name.trim());
          }}
        >
          <FormField label="Organization name" className="flex-1">
            {(p) => (
              <Input
                {...p}
                value={name}
                maxLength={80}
                required
                disabled={!isAdmin}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </FormField>
          {isAdmin && (
            <Button
              type="submit"
              disabled={rename.isPending || !name.trim() || name.trim() === organization?.name}
            >
              Save name
            </Button>
          )}
        </form>
        {!isAdmin && (
          <p className="mt-2 text-sm text-muted-foreground">
            Only owners and admins can rename it.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function Account() {
  const { user, organization, isAdmin, signOut } = useSession();
  const [confirmAll, setConfirmAll] = useState(false);
  const everywhere = useDo(logoutAll);
  const reset = useDo(() => requestPasswordReset(user.email), {
    success: 'We emailed you a link to choose a new password.',
  });

  if (!user) return null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Your profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-muted-foreground">Name</dt>
              <dd className="mt-1">{user.name}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">Email address</dt>
              <dd className="mt-1 break-all">{user.email}</dd>
            </div>
          </dl>
          <Verification user={user} />
        </CardContent>
      </Card>

      <Organization key={organization?.id} organization={organization} isAdmin={isAdmin} />

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Password and sessions</CardTitle>
          <CardDescription>
            To change your password we email you a secure link. Opening it signs you out on every
            device.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={reset.isPending} onClick={() => reset.mutate()}>
            Email me a password reset link
          </Button>
          <Button variant="outline" onClick={() => setConfirmAll(true)}>
            Sign out everywhere
          </Button>
          <Button variant="ghost" onClick={signOut}>
            Sign out
          </Button>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title="Sign out on all devices?"
        description="Every browser signed in to your account, including this one, will need to sign in again."
        confirmLabel="Sign out everywhere"
        loading={everywhere.isPending}
        onConfirm={() => everywhere.mutate(undefined, { onSuccess: () => signOut() })}
      />
    </div>
  );
}
