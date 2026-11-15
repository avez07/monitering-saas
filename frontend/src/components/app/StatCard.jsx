import { Link } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** Big number with a label and an optional hint. Pass `to` to make the whole card a link. */
export function StatCard({ label, value, hint, icon: Icon, to, className }) {
  const body = (
    <CardContent className="flex items-start justify-between gap-3 p-5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
        {hint && <p className="mt-1 text-sm text-muted-foreground">{hint}</p>}
      </div>
      {Icon && (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Icon className="size-5" aria-hidden="true" />
        </span>
      )}
    </CardContent>
  );
  return (
    <Card className={cn(to && 'transition-colors hover:bg-accent', className)}>
      {to ? (
        <Link
          to={to}
          className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {body}
        </Link>
      ) : (
        body
      )}
    </Card>
  );
}
