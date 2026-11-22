import { Link } from 'react-router-dom';
import { Lock, LogOut, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Logo } from './Logo';
import { ThemeToggle } from './ThemeToggle';

/**
 * Full-page notice for members of an organization a Yukti admin suspended. The org API answers 423
 * for everything except /api/bootstrap, so nothing else of the app can load. Members of other
 * organizations can switch to one of them from here.
 */
export function SuspendedNotice() {
  const {
    organization,
    organizations,
    suspended,
    switchOrganization,
    signOut,
    isPlatformAdmin,
    user,
  } = useSession();
  const others = organizations.filter((o) => o.id !== organization?.id && !o.suspendedAt);
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="flex h-14 items-center justify-between border-b border-border/70 px-4 sm:px-6">
        <Logo />
        <ThemeToggle />
      </header>
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-10">
        <section
          aria-labelledby="suspended-title"
          className="w-full max-w-lg rounded-2xl border bg-card p-6 text-card-foreground shadow-sm sm:p-8"
        >
          <span className="mb-4 flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <Lock className="size-5" aria-hidden="true" />
          </span>
          <h1 id="suspended-title" className="text-2xl">
            {organization?.name || 'This organization'} is suspended
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Monitoring, alerts and the dashboard are paused for this organization. Your agents keep
            running but their reports are refused until the organization is reactivated. Your data
            is kept.
          </p>
          <dl className="mt-5 space-y-2 rounded-xl border bg-muted/40 p-4 text-sm">
            {suspended?.reason && (
              <div>
                <dt className="font-medium">Reason</dt>
                <dd className="text-muted-foreground">{suspended.reason}</dd>
              </div>
            )}
            <div>
              <dt className="font-medium">Since</dt>
              <dd className="text-muted-foreground">{formatDateTime(suspended?.at)}</dd>
            </div>
          </dl>
          <p className="mt-5 text-sm">
            To resolve this, contact{' '}
            <a
              className="font-medium text-primary underline-offset-4 hover:underline"
              href="mailto:support@yuktiops.com"
            >
              support@yuktiops.com
            </a>{' '}
            from {user?.email || 'your account email'}.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            {others.map((org) => (
              <Button key={org.id} variant="outline" onClick={() => switchOrganization(org.id)}>
                Switch to {org.name}
              </Button>
            ))}
            {isPlatformAdmin && (
              <Button asChild variant="outline">
                <Link to="/admin">
                  <ShieldCheck className="size-4" aria-hidden="true" /> Yukti Admin
                </Link>
              </Button>
            )}
            <Button variant="ghost" onClick={signOut}>
              <LogOut className="size-4" aria-hidden="true" /> Sign out
            </Button>
          </div>
        </section>
      </main>
    </div>
  );
}
