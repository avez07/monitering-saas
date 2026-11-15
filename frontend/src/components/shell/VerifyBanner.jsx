import { useState } from 'react';
import { MailWarning } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSession } from '@/lib/session';
import { resendVerification, useDo } from '@/pages/settings/api';

/** Shown on every signed-in page until the account's email address is verified. */
export function VerifyBanner() {
  const { user } = useSession();
  const [hidden, setHidden] = useState(false);
  const resend = useDo(resendVerification, {
    success: (r) =>
      r?.alreadyVerified ? 'Your email is already verified.' : 'Verification email sent.',
  });
  if (!user || user.emailVerified !== false || hidden) return null;
  return (
    <div
      role="status"
      data-testid="verify-banner"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-muted px-4 py-2 text-sm text-foreground sm:px-6 lg:px-8"
    >
      <MailWarning className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        Please verify your email. We sent a link to <strong>{user.email}</strong>.
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={resend.isPending}
        onClick={() => resend.mutate()}
      >
        Resend email
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setHidden(true)}>
        Dismiss
      </Button>
    </div>
  );
}
