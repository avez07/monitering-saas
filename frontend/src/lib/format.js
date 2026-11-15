/** Number and time formatters. All return a string and never throw on null/undefined (they give "-"). */
const DASH = '-';
const num = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

export function formatBytes(value, digits = 1) {
  const n = num(value);
  if (n === null) return DASH;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = Math.abs(n);
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${n < 0 ? '-' : ''}${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

/** formatPercent(42.3) gives "42%". The input is already a percentage (0-100). */
export function formatPercent(value, digits = 0) {
  const n = num(value);
  return n === null ? DASH : `${n.toFixed(digits)}%`;
}

export function formatNumber(value) {
  const n = num(value);
  return n === null ? DASH : new Intl.NumberFormat().format(n);
}

/** formatDuration(seconds) gives "3d 4h", "2h 5m", "5m" or "12s". */
export function formatDuration(seconds) {
  const n = num(seconds);
  if (n === null) return DASH;
  const s = Math.max(0, Math.floor(n));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

export function formatMs(value) {
  const n = num(value);
  if (n === null) return DASH;
  return n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`;
}

/** formatRelative(date) gives "just now", "5 minutes ago" or "in 2 hours". */
export function formatRelative(value, now = Date.now()) {
  if (!value) return 'never';
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return DASH;
  const diff = Math.round((t - now) / 1000);
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  const [unit, size] =
    abs >= 86400 ? ['day', 86400] : abs >= 3600 ? ['hour', 3600] : ['minute', 60];
  const count = Math.round(abs / size);
  const label = `${count} ${unit}${count === 1 ? '' : 's'}`;
  return diff < 0 ? `${label} ago` : `in ${label}`;
}

export function formatDateTime(value) {
  if (!value) return DASH;
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? DASH
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
