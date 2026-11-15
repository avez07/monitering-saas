import { Activity } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Logo({ className }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <span className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <Activity className="size-5" aria-hidden="true" />
      </span>
      <span className="text-lg font-semibold tracking-tight">YuktiOps</span>
    </span>
  );
}
