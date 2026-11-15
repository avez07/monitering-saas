/**
 * Status helpers. Backend resource statuses: healthy | warning | unhealthy | unknown.
 * Colours come from theme variables only; the label word is always shown next to the dot.
 */
export const STATUS = {
  healthy: { label: 'Healthy', dot: 'bg-chart-2', bar: '[&>div]:bg-chart-2' },
  warning: { label: 'Needs attention', dot: 'bg-chart-4', bar: '[&>div]:bg-chart-4' },
  unhealthy: { label: 'Down', dot: 'bg-destructive', bar: '[&>div]:bg-destructive' },
  unknown: {
    label: 'Waiting for data',
    dot: 'bg-muted-foreground',
    bar: '[&>div]:bg-muted-foreground',
  },
};
const ALIASES = {
  ok: 'healthy',
  up: 'healthy',
  down: 'unhealthy',
  offline: 'unhealthy',
  critical: 'unhealthy',
  pending: 'unknown',
};

export function statusKey(status) {
  const key = ALIASES[status] || status;
  return STATUS[key] ? key : 'unknown';
}
export const statusInfo = (status) => STATUS[statusKey(status)];

/** Word and level for a usage percentage (thresholds 70 and 90). */
export function usageLevel(percent) {
  if (percent === null || percent === undefined) return { key: 'unknown', label: 'No data' };
  if (percent >= 90) return { key: 'unhealthy', label: 'Very high' };
  if (percent >= 70) return { key: 'warning', label: 'High' };
  return { key: 'healthy', label: 'Normal' };
}
