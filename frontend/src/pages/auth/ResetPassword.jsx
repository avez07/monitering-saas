import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/app/FormField';
import { AuthLayout } from './AuthLayout';
import { resetPassword } from './api';

export default function ResetPassword() {
  const params = useParams();
  const [search] = useSearchParams();
  // The email link carries the token in the query string; /reset-password/:token also works.
  const token = params.token || search.get('token') || '';
  const [error, setError] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const password = String(data.get('password') || '');
    setError('');
    setFieldError('');
    if (password.length < 10) return setFieldError('Use at least 10 characters.');
    if (password !== data.get('confirm')) return setFieldError('The two passwords do not match.');
    setBusy(true);
    try {
      await resetPassword(token, password);
      setDone(true);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <AuthLayout title="Password changed">
        <Alert>
          <CheckCircle2 className="size-4" aria-hidden="true" />
          <AlertTitle>All set</AlertTitle>
          <AlertDescription>
            Your password has been changed and you were signed out everywhere. Sign in with the new
            one.
          </AlertDescription>
        </Alert>
        <Button asChild size="lg" className="mt-6 w-full">
          <Link to="/login">Go to sign in</Link>
        </Button>
      </AuthLayout>
    );

  if (!token)
    return (
      <AuthLayout title="This link is not complete">
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            The reset link is missing its code. Open the link from your email again, or ask for a
            new one.
          </AlertDescription>
        </Alert>
        <Button asChild size="lg" className="mt-6 w-full">
          <Link to="/forgot-password">Ask for a new link</Link>
        </Button>
      </AuthLayout>
    );

  return (
    <AuthLayout title="Choose a new password" subtitle="Use at least 10 characters.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FormField label="New password" error={fieldError}>
          {(p) => (
            <Input
              {...p}
              name="password"
              type="password"
              required
              maxLength={128}
              autoComplete="new-password"
            />
          )}
        </FormField>
        <FormField label="Repeat the new password">
          {(p) => (
            <Input {...p} name="confirm" type="password" required autoComplete="new-password" />
          )}
        </FormField>
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>
              {error}{' '}
              <Link to="/forgot-password" className="font-medium underline underline-offset-4">
                Ask for a new link
              </Link>
            </AlertDescription>
          </Alert>
        )}
        <Button type="submit" size="lg" disabled={busy} className="mt-2 w-full">
          {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          Change password
        </Button>
      </form>
    </AuthLayout>
  );
}
