import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/app/FormField';
import { AuthLayout } from './AuthLayout';

export default function Register() {
  const { signedIn } = useSession();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = Object.fromEntries(new FormData(event.currentTarget));
      await api('/auth/register', { method: 'POST', body });
      signedIn();
      navigate('/', { replace: true });
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Create your account" subtitle="Free for 2 servers. No card needed.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FormField label="Your name">
          {(p) => <Input {...p} name="name" required minLength={2} autoComplete="name" />}
        </FormField>
        <FormField label="Company or organization">
          {(p) => (
            <Input {...p} name="organization" required minLength={2} autoComplete="organization" />
          )}
        </FormField>
        <FormField label="Email address">
          {(p) => <Input {...p} name="email" type="email" required autoComplete="email" />}
        </FormField>
        <FormField label="Password" hint="At least 10 characters.">
          {(p) => (
            <Input
              {...p}
              name="password"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
            />
          )}
        </FormField>
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" size="lg" disabled={busy} className="mt-2 w-full">
          {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          Create account
        </Button>
      </form>
      <p className="mt-6 text-base text-muted-foreground">
        Already have an account?{' '}
        <Link to="/login" className="font-medium text-foreground underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
