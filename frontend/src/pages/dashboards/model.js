// Pure helpers for the Grafana-like dashboard renderer: variables, steps, units, legends,
// thresholds and Prometheus result shaping. No React and no browser APIs, so node:test runs them.
// Contract: docs/api/advanced-telemetry.md section 4.

export const SCRAPE_SECONDS = 15;
export const STEP_FLOOR = 15;
export const MAX_POINTS = 11000;

export const RANGES = [
  { key: '15m', label: '15m', seconds: 15 * 60 },
  { key: '1h', label: '1h', seconds: 3600 },
  { key: '6h', label: '6h', seconds: 6 * 3600 },
  { key: '24h', label: '24h', seconds: 86400 },
  { key: '7d', label: '7d', seconds: 7 * 86400 },
];
export const DEFAULT_RANGE = '1h';
export const rangeSeconds = (key) => (RANGES.find((r) => r.key === key) || RANGES[1]).seconds;

export const REFRESH = [
  { key: 'off', label: 'Off', ms: 0 },
  { key: '30s', label: '30s', ms: 30000 },
  { key: '1m', label: '1m', ms: 60000 },
];
export const refreshMs = (key) => (REFRESH.find((r) => r.key === key) || REFRESH[0]).ms;

// ------------------------------------------------------------------------------------ step / interval

const NICE_STEPS = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

/**
 * Query step in seconds from the time range and the panel width, like Grafana's
 * interval = range / maxDataPoints (one point per pixel, at most 11 000), rounded up to a
 * "nice" step and never below the 15 s floor.
 */
export function stepFor(rangeSec, widthPx = 600) {
  const points = Math.min(MAX_POINTS, Math.max(50, Math.round(Number(widthPx) || 600)));
  const raw = Math.max(STEP_FLOOR, Math.ceil(rangeSec / points), Math.ceil(rangeSec / MAX_POINTS));
  return NICE_STEPS.find((s) => s >= raw) ?? Math.ceil(raw / 86400) * 86400;
}

/** Grafana's $__rate_interval: max($__interval + scrape interval, 4 × scrape interval). */
export const rateInterval = (stepSec, scrape = SCRAPE_SECONDS) =>
  Math.max(stepSec + scrape, 4 * scrape);

/** 90 → "90s", 3600 → "1h", 300 → "5m" (PromQL duration). */
export function promDuration(seconds) {
  const s = Math.max(1, Math.round(seconds));
  if (s % 86400 === 0) return `${s / 86400}d`;
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

// ------------------------------------------------------------------------------------ variables

/** Escape a literal for a PromQL regex inside a double-quoted string (backslashes doubled). */
export const escapeRegexValue = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\\\${c}`);

/** Container picker value → regex for name=~"…". Empty / "All" means every container. */
export function containerRegex(selected) {
  const list = (Array.isArray(selected) ? selected : [selected]).filter((v) => v && v !== '$__all');
  return list.length ? list.map(escapeRegexValue).join('|') : '.*';
}

/** Built-in and user variables for a panel query. */
export function panelVariables({ node = '', nodename = '', container, rangeSec, stepSec }) {
  return {
    node,
    nodename,
    container: containerRegex(container),
    job: 'node',
    cadvisor_job: 'cadvisor',
    __interval: promDuration(stepSec),
    __interval_ms: String(stepSec * 1000),
    __rate_interval: promDuration(rateInterval(stepSec)),
    __range: promDuration(rangeSec),
    __range_s: String(Math.round(rangeSec)),
    __range_ms: String(Math.round(rangeSec * 1000)),
    __all: '.*',
  };
}

/**
 * Replace $name and ${name} (also ${name:format}) with values from `vars`. Unknown variables
 * are left untouched. `$nodename` never matches `$node` because names are matched whole.
 */
export function interpolate(expr, vars) {
  return String(expr ?? '').replace(/\$\{(\w+)(?::[\w-]+)?\}|\$(\w+)/g, (match, braced, bare) => {
    const name = braced ?? bare;
    return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match;
  });
}

// ------------------------------------------------------------------------------------ legends

const HIDDEN_LABELS = new Set(['__name__']);

/** Default series name when there is no legend: name{a="b", …}. */
export function seriesName(metric = {}) {
  const name = metric.__name__ || '';
  const labels = Object.entries(metric)
    .filter(([k]) => !HIDDEN_LABELS.has(k) && !k.startsWith('yk_'))
    .map(([k, v]) => `${k}="${v}"`);
  if (!labels.length) return name || 'Value';
  return `${name}{${labels.join(', ')}}`;
}

/** Grafana legend templating: "{{device}} - Read" with the series' labels. "__auto" or empty = default name. */
export function legendLabel(template, metric = {}) {
  if (!template || template === '__auto') return seriesName(metric);
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => metric[k] ?? '');
}

// ------------------------------------------------------------------------------------ units

const DASH = '-';
const toNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function autoDecimals(abs) {
  if (abs === 0) return 0;
  if (abs < 1) return 3;
  if (abs < 10) return 2;
  if (abs < 100) return 1;
  return 0;
}
const fixed = (v, decimals) => {
  const d = decimals ?? autoDecimals(Math.abs(v));
  const s = v.toFixed(d);
  // Auto decimals drop trailing zeros ("2.50" → "2.5"); explicit decimals keep them.
  return decimals == null && s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};

function scaled(v, base, suffixes, decimals, sep = ' ') {
  let i = 0;
  let x = Math.abs(v);
  while (x >= base && i < suffixes.length - 1) {
    x /= base;
    i++;
  }
  const out = `${v < 0 ? '-' : ''}${fixed(x, decimals)}`;
  return suffixes[i] ? `${out}${sep}${suffixes[i]}` : out;
}

const SHORT = ['', 'K', 'M', 'B', 'T', 'P'];
const short = (v, d) => scaled(v, 1000, SHORT, d, '');

function duration(seconds, decimals) {
  const a = Math.abs(seconds);
  if (a === 0) return '0 s';
  if (a < 1e-3) return `${fixed(seconds * 1e6, decimals)} µs`;
  if (a < 1) return `${fixed(seconds * 1000, decimals)} ms`;
  if (a < 60) return `${fixed(seconds, decimals)} s`;
  if (a < 3600) return `${fixed(seconds / 60, decimals)} min`;
  if (a < 86400) return `${fixed(seconds / 3600, decimals)} hour`;
  if (a < 86400 * 365) return `${fixed(seconds / 86400, decimals)} day`;
  return `${fixed(seconds / (86400 * 365), decimals)} year`;
}

/**
 * Format a value with a Grafana unit id: percent, percentunit, bytes (IEC), decbytes (SI),
 * bps / Bps, s / ms / d, short, ops, iops, pps, eps, none, bool_yes_no. Unknown units use short.
 */
export function formatValue(value, unit = 'short', decimals) {
  const v = toNum(value);
  if (v === null) return DASH;
  const d = decimals ?? undefined;
  switch (unit) {
    case 'percent':
      return `${fixed(v, d)}%`;
    case 'percentunit':
      return `${fixed(v * 100, d)}%`;
    case 'bytes':
      return scaled(v, 1024, ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'], d);
    case 'decbytes':
      return scaled(v, 1000, ['B', 'kB', 'MB', 'GB', 'TB', 'PB'], d);
    case 'bits':
      return scaled(v, 1000, ['b', 'kb', 'Mb', 'Gb', 'Tb'], d);
    case 'bps':
      return scaled(v, 1000, ['b/s', 'kb/s', 'Mb/s', 'Gb/s', 'Tb/s'], d);
    case 'Bps':
      return scaled(v, 1000, ['B/s', 'kB/s', 'MB/s', 'GB/s', 'TB/s'], d);
    case 'binBps':
      return scaled(v, 1024, ['B/s', 'KiB/s', 'MiB/s', 'GiB/s', 'TiB/s'], d);
    case 's':
    case 'dtdurations':
      return duration(v, d);
    case 'ms':
      return duration(v / 1000, d);
    case 'd':
      return duration(v * 86400, d);
    case 'ops':
      return `${short(v, d)} ops/s`;
    case 'iops':
      return `${short(v, d)} io/s`;
    case 'pps':
      return `${short(v, d)} p/s`;
    case 'eps':
      return `${short(v, d)} evt/s`;
    case 'rps':
      return `${short(v, d)} req/s`;
    case 'bool_yes_no':
      return v ? 'Yes' : 'No';
    case 'bool_on_off':
      return v ? 'On' : 'Off';
    case 'none':
      return fixed(v, d);
    case 'short':
    default:
      return short(v, d);
  }
}

// ------------------------------------------------------------------------------------ thresholds

// Grafana palette names and the rgba() steps used by the reference → theme tokens.
const COLOR_TOKENS = {
  green: 'hsl(var(--success))',
  'dark-green': 'hsl(var(--success))',
  'semi-dark-green': 'hsl(var(--success))',
  'light-green': 'hsl(var(--chart-2))',
  red: 'hsl(var(--destructive))',
  'dark-red': 'hsl(var(--destructive))',
  'semi-dark-red': 'hsl(var(--destructive))',
  'light-red': 'hsl(var(--destructive))',
  orange: 'hsl(var(--warning))',
  'dark-orange': 'hsl(var(--warning))',
  yellow: 'hsl(var(--chart-3))',
  'dark-yellow': 'hsl(var(--chart-3))',
  blue: 'hsl(var(--chart-4))',
  'dark-blue': 'hsl(var(--chart-4))',
  purple: 'hsl(var(--chart-5))',
  text: 'hsl(var(--foreground))',
  transparent: 'transparent',
  'rgba(50, 172, 45, 0.97)': 'hsl(var(--success))',
  'rgba(237, 129, 40, 0.89)': 'hsl(var(--warning))',
  'rgba(245, 54, 54, 0.9)': 'hsl(var(--destructive))',
};
export const themeColor = (c) => (c ? (COLOR_TOKENS[c] ?? COLOR_TOKENS[String(c).toLowerCase()] ?? c) : null);

/** Colour of the highest threshold step at or below `value` (a null step value is the base). */
export function thresholdColor(value, thresholds) {
  const v = toNum(value);
  if (!thresholds?.length) return null;
  const steps = [...thresholds].sort(
    (a, b) => (a.value ?? -Infinity) - (b.value ?? -Infinity),
  );
  let color = steps[0].color;
  if (v !== null) for (const s of steps) if (s.value === null || s.value === undefined || v >= s.value) color = s.color;
  return themeColor(color);
}

// ------------------------------------------------------------------------------------ results

/** Prometheus sample string → number, NaN / Inf → null. */
export const sampleValue = (s) => toNum(s);

/**
 * Prometheus matrix results (one array per target) → TimeSeriesChart data.
 * targets: [{ legend }], results: [[{ metric, values: [[ts, "v"]] }]] (same order).
 * Returns { data: [{ t: ms, s0: n, … }], series: [{ key, label }] } sorted by time.
 */
export function toChartData(results, targets = []) {
  const rows = new Map();
  const series = [];
  results.forEach((result, ti) => {
    (result || []).forEach((r) => {
      const key = `s${series.length}`;
      series.push({ key, label: legendLabel(targets[ti]?.legend, r.metric) });
      for (const [ts, raw] of r.values || (r.value ? [r.value] : [])) {
        const t = Math.round(Number(ts) * 1000);
        if (!rows.has(t)) rows.set(t, { t });
        rows.get(t)[key] = sampleValue(raw);
      }
    });
  });
  const data = [...rows.values()].sort((a, b) => a.t - b.t);
  return { data, series };
}

/** Last non-null value of a series (matrix `values` or instant `value`). */
export function lastValue(r) {
  if (!r) return null;
  if (r.value) return sampleValue(r.value[1]);
  const values = r.values || [];
  for (let i = values.length - 1; i >= 0; i--) {
    const v = sampleValue(values[i][1]);
    if (v !== null) return v;
  }
  return null;
}

/** One reduced value per series across all targets: [{ label, value, metric }]. */
export function reduceSeries(results, targets = []) {
  const out = [];
  results.forEach((result, ti) =>
    (result || []).forEach((r) =>
      out.push({ label: legendLabel(targets[ti]?.legend, r.metric), value: lastValue(r), metric: r.metric || {} }),
    ),
  );
  return out;
}

const TABLE_HIDDEN = new Set(['__name__', 'job', 'instance', 'nodename']);

/**
 * Table panel: rows joined on their label set, one value column per target.
 * Returns { columns: [{ key, label, value? }], rows: [{ key, …labels, v0, v1 }] }.
 */
export function toTable(results, targets = []) {
  const labelKeys = new Set();
  const rows = new Map();
  results.forEach((result, ti) =>
    (result || []).forEach((r) => {
      const labels = Object.fromEntries(
        Object.entries(r.metric || {}).filter(([k]) => !TABLE_HIDDEN.has(k) && !k.startsWith('yk_')),
      );
      Object.keys(labels).forEach((k) => labelKeys.add(k));
      const key = JSON.stringify(Object.entries(labels).sort());
      if (!rows.has(key)) rows.set(key, { key, ...labels });
      rows.get(key)[`v${ti}`] = lastValue(r);
    }),
  );
  const columns = [
    ...[...labelKeys].sort().map((k) => ({ key: k, label: k })),
    ...results.map((_, ti) => ({
      key: `v${ti}`,
      label: targets[ti]?.legend && !targets[ti].legend.includes('{{') ? targets[ti].legend : results.length > 1 ? `Value ${String.fromCharCode(65 + ti)}` : 'Value',
      value: true,
    })),
  ];
  return { columns, rows: [...rows.values()] };
}

// ------------------------------------------------------------------------------------ layout

export const GRID_ROW_PX = 30;
export const GRID_GAP_PX = 8;
export const panelHeightPx = (h = 8) => h * GRID_ROW_PX + (h - 1) * GRID_GAP_PX;

/** Panels with y made relative to the row (Grafana stores absolute y) and sorted for reading order. */
export function layoutPanels(panels = []) {
  const minY = Math.min(...panels.map((p) => p.grid?.y ?? 0), Infinity);
  return panels
    .map((p) => {
      const g = { x: 0, y: 0, w: 12, h: 8, ...p.grid };
      const w = Math.max(1, Math.min(24, g.w));
      return { ...p, grid: { x: Math.max(0, Math.min(24 - w, g.x)), y: g.y - (Number.isFinite(minY) ? minY : 0), w, h: Math.max(2, g.h) } };
    })
    .sort((a, b) => a.grid.y - b.grid.y || a.grid.x - b.grid.x);
}

/** Does a panel query need a range query (timeseries) or an instant one? */
export const isInstant = (panel, target) =>
  target?.instant === true || (panel.type !== 'timeseries' && target?.instant !== false);
