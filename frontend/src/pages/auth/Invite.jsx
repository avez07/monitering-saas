import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Users } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/app/FormField';
import { session as orgStore } from '@/lib/api';
import { useSession } from '@/lib/session';
import { AuthLayout } from './AuthLayout';
import { acceptInvite, getInvite } from './api';

const ROLE_TEXT = {
  admin: 'Admin: can manage servers, websites, alerts and the team.',
  viewer: 'Viewer: can look at everything but cannot change anything.',
};
const GONE = {
  expired: ['This invitation has expired', 'Ask the person who invited you to send a new one.'],
  used: ['This invitation was already used', 'If that was you, just sign in.'],
  revoked: ['This invitation was cancelled', 'Ask the person who invited you to send a new one.'],
};

export default function Invite() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { status, user, signedIn, signOut } = useSession();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const invite = useQuery({
    queryKey: ['invite', token],
    queryFn: () => getInvite(token),
    retry: false,
  });

  async function accept(body) {
    setBusy(true);
    setError('');
    try {
      const result = await acceptInvite(token, body);
      signedIn();
      // Open the organization we just joined, not the last one this browser remembered.
      if (result?.organization?.id) orgStore.org = result.organization.id;
      navigate('/', { replace: true });
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  if (invite.isPending || status === 'checking')
    return (
      <AuthLayout title="Opening your invitation">
        <p role="status" className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" aria-hidden="true" /> Loading…
        </p>
      </AuthLayout>
    );

  if (invite.isError) {
    const failure = invite.error;
    const [title, text] =
      GONE[failure.reason] ||
      (failure.status === 404
        ? [
            'We could not find this invitation',
            'Check that you opened the whole link from your email.',
          ]
        : ['We could not open this invitation', failure.message]);
    return (
      <AuthLayout title={title}>
        <Alert variant="destructive" role="alert">
          <AlertDescription>{text}</AlertDescription>
        </Alert>
        <Button asChild size="lg" className="mt-6 w-full">
          <Link to={status === 'in' ? '/' : '/login'}>
            {status === 'in' ? 'Go to dashboard' : 'Sign in'}
          </Link>
        </Button>
      </AuthLayout>
    );
  }

  const data = invite.data;
  const summary = (
    <div className="mb-6 flex items-start gap-3 rounded-lg border bg-card p-4">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <Users className="size-5" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="font-medium">{data.organizationName}</p>
        <p className="text-sm text-muted-foreground">
          {data.invitedByName ? `${data.invitedByName} invited ` : 'Invitation for '}
          <span className="break-all">{data.email}</span>
        </p>
        <p className="mt-1 text-sm text-muted-foreground">{ROLE_TEXT[data.role] || data.role}</p>
      </div>
    </div>
  );
  const failure = error && (
    <Alert variant="destructive" role="alert" className="mt-4">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );
  const title = `Join ${data.organizationName}`;

  // Signed in as someone else.
  if (status === 'in' && user && user.email?.toLowerCase() !== data.email.toLowerCase())
    return (
      <AuthLayout title={title}>
        {summary}
        <Alert role="alert">
          <AlertDescription>
            You are signed in as {user.email}, but this invitation is for {data.email}. Sign out,
            then open the link again to continue.
          </AlertDescription>
        </Alert>
        <Button size="lg" className="mt-6 w-full" onClick={signOut}>
          Sign out
        </Button>
      </AuthLayout>
    );

  // Signed in as the invited person: one click.
  if (status === 'in')
    return (
      <AuthLayout title={title} subtitle="You are signed in with the invited email address.">
        {summary}
        <Button size="lg" className="w-full" disabled={busy} onClick={() => accept({})}>
          {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          Join {data.organizationName}
        </Button>
        {failure}
      </AuthLayout>
    );

  // Signed out, already has an account: sign in first.
  if (data.userExists)
    return (
      <AuthLayout title={title} subtitle="You already have an account. Sign in to join.">
        {summary}
        <Button asChild size="lg" className="w-full">
          <Link to="/login">Sign in to join</Link>
        </Button>
        <p className="mt-4 text-sm text-muted-foreground">
          After signing in, open the link from your email again.
        </p>
      </AuthLayout>
    );

  // New person: choose a name and password.
  return (
    <AuthLayout title={title} subtitle="Create your account to join the team.">
      {summary}
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          accept({ name: String(form.get('name')).trim(), password: String(form.get('password')) });
        }}
      >
        <FormField label="Your name">
          {(p) => <Input {...p} name="name" required maxLength={80} autoComplete="name" />}
        </FormField>
        <FormField label="Choose a password" hint="At least 10 characters.">
          {(p) => (
            <Input
              {...p}
              name="password"
              type="password"
              required
              minLength={10}
              maxLength={128}
              autoComplete="new-password"
            />
          )}
        </FormField>
        <Button type="submit" size="lg" disabled={busy} className="w-full">
          {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          Create account and join
        </Button>
      </form>
      {failure}
    </AuthLayout>
  );
}
