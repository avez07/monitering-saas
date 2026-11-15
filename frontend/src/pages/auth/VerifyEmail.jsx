import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useSession } from '@/lib/session';
import { AuthLayout } from './AuthLayout';
import { verifyEmail } from './api';

export default function VerifyEmail() {
  const params = useParams();
  const [search] = useSearchParams();
  const token = params.token || search.get('token') || '';
  const { status } = useSession();
  const client = useQueryClient();
  const [state, setState] = useState(token ? 'working' : 'failed');
  const [message, setMessage] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true; // a link works once, so never send it twice (StrictMode)
    verifyEmail(token)
      .then(() => {
        setState('done');
        client.invalidateQueries({ queryKey: ['session'] });
      })
      .catch((failure) => {
        setMessage(failure.message);
        setState('failed');
      });
  }, [token, client]);

  const signedIn = status === 'in';

  if (state === 'working')
    return (
      <AuthLayout title="Verifying your email">
        <p role="status" className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" aria-hidden="true" /> One moment…
        </p>
      </AuthLayout>
    );
  if (state === 'done')
    return (
      <AuthLayout title="Email verified">
        <Alert>
          <CheckCircle2 className="size-4" aria-hidden="true" />
          <AlertTitle>Thank you</AlertTitle>
          <AlertDescription>Your email address is confirmed.</AlertDescription>
        </Alert>
        <Button asChild size="lg" className="mt-6 w-full">
          <Link to={signedIn ? '/' : '/login'}>
            {signedIn ? 'Go to your dashboard' : 'Sign in'}
          </Link>
        </Button>
      </AuthLayout>
    );
  return (
    <AuthLayout title="We could not verify this link">
      <Alert variant="destructive" role="alert">
        <AlertDescription>
          {message || 'This link is invalid or has expired.'} If you already used it, your email is
          probably confirmed.
        </AlertDescription>
      </Alert>
      <p className="mt-4 text-base text-muted-foreground">
        {signedIn
          ? 'You can send a fresh link from Settings, Account.'
          : 'Sign in, then send a fresh link from Settings, Account.'}
      </p>
      <Button asChild size="lg" className="mt-6 w-full">
        <Link to={signedIn ? '/settings/account' : '/login'}>
          {signedIn ? 'Open account settings' : 'Sign in'}
        </Link>
      </Button>
    </AuthLayout>
  );
}
