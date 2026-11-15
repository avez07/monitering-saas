import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, MailCheck } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/app/FormField';
import { AuthLayout } from './AuthLayout';
import { forgotPassword } from './api';

export default function ForgotPassword() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState('');

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const email = String(new FormData(event.currentTarget).get('email') || '').trim();
    try {
      await forgotPassword(email);
      setSentTo(email);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  if (sentTo)
    return (
      <AuthLayout title="Check your email">
        <Alert>
          <MailCheck className="size-4" aria-hidden="true" />
          <AlertTitle>Reset link on its way</AlertTitle>
          <AlertDescription>
            If {sentTo} has an account, we have sent a link to choose a new password. It works for 1
            hour and only once. Nothing there? Check your spam folder.
          </AlertDescription>
        </Alert>
        <Button variant="outline" className="mt-6 w-full" onClick={() => setSentTo('')}>
          Use a different email
        </Button>
        <p className="mt-6 text-base text-muted-foreground">
          <Link to="/login" className="font-medium text-foreground underline underline-offset-4">
            Back to sign in
          </Link>
        </p>
      </AuthLayout>
    );

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="Enter your email address and we will send you a link to choose a new one."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FormField label="Email address">
          {(p) => <Input {...p} name="email" type="email" required autoComplete="email" />}
        </FormField>
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" size="lg" disabled={busy} className="mt-2 w-full">
          {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          Send reset link
        </Button>
      </form>
      <p className="mt-6 text-base text-muted-foreground">
        Remembered it?{' '}
        <Link to="/login" className="font-medium text-foreground underline underline-offset-4">
          Back to sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
