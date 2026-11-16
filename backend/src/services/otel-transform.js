/**
 * OTLP request objects (from otel-proto `decodeRequest`) -> flat ClickHouse rows shaped like the official
 * OTel Collector ClickHouse exporter, without OrgId/ExpireAt/IngestSeq (the worker adds those).
 */
const MAX_VALUE = 16384; // characters kept per attribute value, log body, status message
const MAX_ATTRS = 128; // attributes kept per object
const MAX_EVENTS = 128;
const MAX_LINKS = 64;

const KINDS = ['Unspecified', 'Internal', 'Server', 'Client', 'Producer', 'Consumer'];
const STATUS = ['Unset', 'Ok', 'Error'];
const ENUM_NAMES = (prefix, list) => Object.fromEntries(list.map((n, i) => [`${prefix}_${n.toUpperCase()}`, i]));
const KIND_BY_NAME = ENUM_NAMES('SPAN_KIND', KINDS);
const STATUS_BY_NAME = ENUM_NAMES('STATUS_CODE', STATUS);

const clip = (s) => (s.length > MAX_VALUE ? s.slice(0, MAX_VALUE) : s);
const enumNumber = (value, names, fallback = 0) =>
  typeof value === 'number' ? value : typeof value === 'string' ? (names[value] ?? (Number.isNaN(Number(value)) ? fallback : Number(value))) : fallback;

/** An OTLP AnyValue as plain JS. */
function plain(v) {
  if (!v || typeof v !== 'object') return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.intValue !== undefined) return String(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(plain);
  if (v.kvlistValue) return Object.fromEntries((v.kvlistValue.values ?? []).map((kv) => [kv.key, plain(kv.value)]));
  if (v.bytesValue !== undefined) return String(v.bytesValue);
  return null;
}
const stringOf = (v) => {
  const value = plain(v);
  if (value === null || value === undefined) return '';
  return clip(typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value));
};
/** KeyValue[] -> { key: string }. */
export function attributesOf(list) {
  const out = {};
  let n = 0;
  for (const kv of list ?? []) {
    if (!kv?.key || n >= MAX_ATTRS) continue;
    out[String(kv.key).slice(0, 256)] = stringOf(kv.value);
    n++;
  }
  return out;
}

const pad = (n, w) => String(n).padStart(w, '0');
/** Unix nanoseconds (string or number) -> "YYYY-MM-DD HH:MM:SS.nnnnnnnnn" for DateTime64(9), or null. */
export function nanosToDateTime(ns) {
  let value;
  try {
    value = BigInt(ns ?? 0);
  } catch {
    return null;
  }
  if (value <= 0n) return null;
  const ms = Number(value / 1000000n);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toISOString().slice(0, 19).replace('T', ' ')}.${pad(value % 1000000000n, 9)}`;
}
const dateTimeFromMs = (ms) => nanosToDateTime(BigInt(Math.trunc(ms)) * 1000000n);

const hexId = (value, length, proto) => {
  if (typeof value !== 'string' || !value) return '';
  const hex = proto ? Buffer.from(value, 'base64').toString('hex') : value.toLowerCase();
  return hex.length === length && /^[0-9a-f]+$/.test(hex) && !/^0+$/.test(hex) ? hex : '';
};
const validTraceId = (id) => id.length === 32;

function serviceOf(resourceAttributes) {
  return (resourceAttributes['service.name'] || 'unknown_service').slice(0, 200);
}

/** Spans: returns { rows, rejected }. A span without valid trace and span ids is rejected. */
export function flattenTraces(request, { proto = false, receivedAt = Date.now() } = {}) {
  const rows = [];
  let rejected = 0;
  for (const rs of request.resourceSpans ?? []) {
    const resourceAttributes = attributesOf(rs.resource?.attributes);
    const service = serviceOf(resourceAttributes);
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const traceId = hexId(span.traceId, 32, proto);
        const spanId = hexId(span.spanId, 16, proto);
        if (!traceId || !spanId) {
          rejected++;
          continue;
        }
        const start = BigInt(span.startTimeUnixNano || 0);
        const end = BigInt(span.endTimeUnixNano || 0);
        const events = (span.events ?? []).slice(0, MAX_EVENTS);
        const links = (span.links ?? []).slice(0, MAX_LINKS);
        rows.push({
          Timestamp: nanosToDateTime(start) ?? dateTimeFromMs(receivedAt),
          TraceId: traceId,
          SpanId: spanId,
          ParentSpanId: hexId(span.parentSpanId, 16, proto),
          TraceState: clip(span.traceState ?? ''),
          SpanName: clip(span.name ?? '').slice(0, 512),
          SpanKind: KINDS[enumNumber(span.kind, KIND_BY_NAME)] ?? 'Unspecified',
          ServiceName: service,
          ResourceAttributes: resourceAttributes,
          ScopeName: ss.scope?.name ?? '',
          ScopeVersion: ss.scope?.version ?? '',
          SpanAttributes: attributesOf(span.attributes),
          Duration: end > start ? Number(end - start) : 0,
          StatusCode: STATUS[enumNumber(span.status?.code, STATUS_BY_NAME)] ?? 'Unset',
          StatusMessage: clip(span.status?.message ?? ''),
          'Events.Timestamp': events.map((e) => nanosToDateTime(e.timeUnixNano) ?? nanosToDateTime(start) ?? dateTimeFromMs(receivedAt)),
          'Events.Name': events.map((e) => clip(e.name ?? '').slice(0, 256)),
          'Events.Attributes': events.map((e) => attributesOf(e.attributes)),
          'Links.TraceId': links.map((l) => hexId(l.traceId, 32, proto)),
          'Links.SpanId': links.map((l) => hexId(l.spanId, 16, proto)),
          'Links.TraceState': links.map((l) => l.traceState ?? ''),
          'Links.Attributes': links.map((l) => attributesOf(l.attributes)),
        });
      }
    }
  }
  return { rows, rejected };
}

const SEVERITY_TEXT = ['', 'TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
/** Severity number 1..24 -> level index 1..6 (trace..fatal). */
export const levelOfSeverityNumber = (n) => (n >= 1 ? Math.min(6, Math.floor((n - 1) / 4) + 1) : 0);
export const SEVERITY_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
export const SEVERITY_MIN_NUMBER = Object.fromEntries(SEVERITY_LEVELS.map((name, i) => [name, i * 4 + 1]));

export function flattenLogs(request, { proto = false, receivedAt = Date.now() } = {}) {
  const rows = [];
  let rejected = 0;
  for (const rl of request.resourceLogs ?? []) {
    const resourceAttributes = attributesOf(rl.resource?.attributes);
    const service = serviceOf(resourceAttributes);
    for (const sl of rl.scopeLogs ?? []) {
      for (const record of sl.logRecords ?? []) {
        const number = Math.max(0, Math.min(24, enumNumber(record.severityNumber, {})));
        const time = nanosToDateTime(record.timeUnixNano) ?? nanosToDateTime(record.observedTimeUnixNano) ?? dateTimeFromMs(receivedAt);
        if (!time) {
          rejected++;
          continue;
        }
        rows.push({
          Timestamp: time,
          TraceId: hexId(record.traceId, 32, proto),
          SpanId: hexId(record.spanId, 16, proto),
          TraceFlags: Number(record.flags ?? 0) & 0xff,
          SeverityText: (record.severityText || SEVERITY_TEXT[levelOfSeverityNumber(number)] || '').slice(0, 32),
          SeverityNumber: number,
          ServiceName: service,
          Body: stringOf(record.body),
          ResourceAttributes: resourceAttributes,
          LogAttributes: attributesOf(record.attributes),
        });
      }
    }
  }
  return { rows, rejected };
}

/** Number of data points in a metrics request (nothing is stored; this is for the response and usage). */
export function countDataPoints(request) {
  let n = 0;
  for (const rm of request.resourceMetrics ?? [])
    for (const sm of rm.scopeMetrics ?? [])
      for (const m of sm.metrics ?? [])
        for (const key of ['gauge', 'sum', 'histogram', 'exponentialHistogram', 'summary'])
          n += m[key]?.dataPoints?.length ?? 0;
  return n;
}

/** How many spans/records in a decoded request are unusable (used for `partial_success` without a full flatten). */
export function countInvalid(signal, request, proto) {
  let bad = 0;
  if (signal === 'traces')
    for (const rs of request.resourceSpans ?? [])
      for (const ss of rs.scopeSpans ?? [])
        for (const s of ss.spans ?? [])
          if (!hexId(s.traceId, 32, proto) || !hexId(s.spanId, 16, proto)) bad++;
  return bad;
}
export { validTraceId };
