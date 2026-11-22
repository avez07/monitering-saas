import { Activity } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Brand mark. `compact` renders only the rounded mark (used when the sidebar is collapsed). */
export function Logo({ className, compact = false }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
        <Activity className="size-[18px]" aria-hidden="true" />
      </span>
      {!compact && <span className="font-serif text-base font-semibold tracking-tight">YuktiOps</span>}
    </span>
  );
}
