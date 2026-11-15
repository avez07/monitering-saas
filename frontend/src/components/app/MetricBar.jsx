import { Progress } from '@/components/ui/progress';
import { formatPercent } from '@/lib/format';
import { STATUS, usageLevel } from '@/lib/status';
import { cn } from '@/lib/utils';

/** Usage bar with the percentage and a word (Normal / High / Very high), never colour alone. */
export function MetricBar({ label, value, detail, className }) {
  const level = usageLevel(value);
  const pct = value === null || value === undefined ? 0 : Math.min(100, Math.max(0, value));
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          <span className="font-semibold text-foreground">{formatPercent(value)}</span> ·{' '}
          {level.label}
        </span>
      </div>
      <Progress
        value={pct}
        aria-label={`${label} usage`}
        className={cn('h-2', STATUS[level.key].bar)}
      />
      {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}
