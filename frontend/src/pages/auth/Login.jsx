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

export default function Login() {
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
      // The server sets an httpOnly session cookie; nothing secret is kept in page storage.
      await api('/auth/login', { method: 'POST', body });
      signedIn();
      navigate('/', { replace: true });
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to see how your servers and websites are doing."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FormField label="Email address">
          {(p) => <Input {...p} name="email" type="email" required autoComplete="email" />}
        </FormField>
        <FormField label="Password">
          {(p) => (
            <Input
              {...p}
              name="password"
              type="password"
              required
              autoComplete="current-password"
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
          Sign in
        </Button>
        <Link
          to="/forgot-password"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Forgot your password?
        </Link>
      </form>
      <p className="mt-6 text-base text-muted-foreground">
        New to YuktiOps?{' '}
        <Link to="/register" className="font-medium text-foreground underline underline-offset-4">
          Create an account
        </Link>
      </p>
    </AuthLayout>
  );
}
