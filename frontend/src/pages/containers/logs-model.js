// Pure helpers for the container Logs tab. No React, no browser APIs (node:test runs them).
// Contract: docs/api/advanced-telemetry.md section 5.

export const LOG_RANGES = [
  { key: '15m', label: 'Last 15 minutes', seconds: 900 },
  { key: '1h', label: 'Last hour', seconds: 3600 },
  { key: '6h', label: 'Last 6 hours', seconds: 6 * 3600 },
  { key: '24h', label: 'Last 24 hours', seconds: 86400 },
  { key: '7d', label: 'Last 7 days', seconds: 7 * 86400 },
];
export const LEVELS = [
  { value: '', label: 'All levels' },
  { value: 'error', label: 'Error' },
  { value: 'warn', label: 'Warning' },
  { value: 'info', label: 'Info' },
  { value: 'debug', label: 'Debug' },
];
export const STREAMS = [
  { value: '', label: 'stdout and stderr' },
  { value: 'stdout', label: 'stdout' },
  { value: 'stderr', label: 'stderr' },
];
export const PAGE_LIMIT = 500;
export const MAX_LINES = 5000;

/** "ERROR", "Err", "fatal", "warning" → error | warn | info | debug | "" */
export function normalizeLevel(level) {
  const l = String(level || '').toLowerCase();
  if (/^(fatal|crit|critical|emerg|alert|err|error|panic)/.test(l)) return 'error';
  if (/^warn/.test(l)) return 'warn';
  if (/^(info|notice)/.test(l)) return 'info';
  if (/^(debug|trace)/.test(l)) return 'debug';
  return '';
}

/** Query params for GET /containers/:id/logs. `since` wins over the range when given. */
export function logParams({ range = '1h', q = '', level = '', stream = '' }, { since, now = Date.now(), limit = PAGE_LIMIT } = {}) {
  const seconds = (LOG_RANGES.find((r) => r.key === range) || LOG_RANGES[1]).seconds;
  return {
    since: since || new Date(now - seconds * 1000).toISOString(),
    q: q.trim(),
    level,
    stream,
    limit: Math.min(1000, limit),
  };
}

export const lineKey = (l) => `${l.time}|${l.stream}|${l.message}`;

/**
 * Merge new lines into the list: dedupe (the since= boundary may repeat a line), sort by time
 * (oldest first, like a terminal) and keep the newest `max` lines.
 */
export function mergeLines(old, incoming, max = MAX_LINES) {
  const seen = new Set(old.map(lineKey));
  const added = (incoming || []).filter((l) => {
    const k = lineKey(l);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!added.length) return old;
  const all = [...old, ...added];
  const sorted = all.every((l, i) => i === 0 || all[i - 1].time <= l.time)
    ? all
    : [...all].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return sorted.length > max ? sorted.slice(sorted.length - max) : sorted;
}

/** Plain-text export: one "time stream LEVEL message" line per log line. */
export function linesToText(lines) {
  return lines
    .map((l) => [l.time, l.stream || '-', (normalizeLevel(l.level) || '-').toUpperCase(), l.message].join(' '))
    .join('\n');
}

/** Is the scroll box within `slack` px of its bottom? */
export const atBottom = ({ scrollTop, scrollHeight, clientHeight }, slack = 24) =>
  scrollHeight - scrollTop - clientHeight <= slack;
