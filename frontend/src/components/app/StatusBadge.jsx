import { Badge } from '@/components/ui/badge';
import { statusInfo } from '@/lib/status';
import { cn } from '@/lib/utils';

/**
 * Status as a coloured dot AND a word. `status`: healthy | warning | unhealthy | unknown
 * (aliases such as up/down/offline work too). Pass `label` to override the word.
 */
export function StatusBadge({ status, label, className }) {
  const info = statusInfo(status);
  return (
    <Badge
      variant="outline"
      className={cn('gap-1.5 whitespace-nowrap py-0.5 text-sm font-medium', className)}
    >
      <span className={cn('size-2 rounded-full', info.dot)} aria-hidden="true" />
      {label || info.label}
    </Badge>
  );
}
