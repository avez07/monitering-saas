import { AlertTriangle, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * Empty state with exactly one next action: `action` = { label, to } (link) or { label, onClick }.
 */
export function EmptyState({ icon: Icon, title, text, action, className }) {
  return (
    <div
      className={cn(
        'flex flex-col items-center rounded-lg border border-dashed px-6 py-12 text-center',
        className,
      )}
    >
      {Icon && (
        <span className="mb-4 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="size-6" aria-hidden="true" />
        </span>
      )}
      <h2 className="text-lg font-semibold">{title}</h2>
      {text && <p className="mt-1 max-w-md text-base text-muted-foreground">{text}</p>}
      {action && (
        <div className="mt-5">
          {action.to ? (
            <Button asChild>
              <Link to={action.to}>{action.label}</Link>
            </Button>
          ) : (
            <Button onClick={action.onClick}>{action.label}</Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Code, cause, hint and time from a structured API error (only the parts that exist). */
export function ErrorDetails({ error }) {
  const d = error?.details;
  if (!d || (!d.code && !d.cause && !d.hint)) return null;
  return (
    <dl className="mt-3 max-w-md space-y-1 text-left text-sm text-muted-foreground">
      {error.status ? <div>HTTP {error.status}{d.code ? <> · <code>{d.code}</code></> : null}{d.service ? <> · {d.service}</> : null}</div> : null}
      {d.cause ? <div>Reason: {d.cause}</div> : null}
      {d.hint ? <div>What to do: {d.hint}</div> : null}
      {d.timestamp ? <div>At: {new Date(d.timestamp).toLocaleString()}{d.errorId ? <> · id <code>{d.errorId}</code></> : null}</div> : null}
    </dl>
  );
}

/** Error with a plain message and a Try again button when `onRetry` is given. */
export function ErrorState({ title = 'Something went wrong', error, onRetry, className }) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center rounded-lg border border-destructive/40 px-6 py-10 text-center',
        className,
      )}
    >
      <span className="mb-3 flex size-12 items-center justify-center rounded-full bg-muted text-destructive">
        <AlertTriangle className="size-6" aria-hidden="true" />
      </span>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-1 max-w-md text-base text-muted-foreground">
        {error?.message || (typeof error === 'string' ? error : 'Please try again in a moment.')}
      </p>
      <ErrorDetails error={error} />
      {onRetry && (
        <Button variant="outline" className="mt-5" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** Centered spinner with a text. `fullScreen` for the first app load. */
export function LoadingState({ label = 'Loading…', fullScreen = false, className }) {
  return (
    <div
      role="status"
      className={cn(
        'flex items-center justify-center gap-2 py-12 text-muted-foreground',
        fullScreen && 'min-h-dvh',
        className,
      )}
    >
      <Loader2 className="size-5 animate-spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function CardSkeleton({ className }) {
  return (
    <Card className={className} aria-hidden="true">
      <CardContent className="space-y-3 p-5">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-20" />
        <Skeleton className="h-3 w-32" />
      </CardContent>
    </Card>
  );
}

export function StatGridSkeleton({ count = 4 }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" role="status" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 5 }) {
  return (
    <div className="space-y-2" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}
