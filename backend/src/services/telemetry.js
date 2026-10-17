import { config } from '../config.js';
import { assert, HttpError } from '../lib/errors.js';
import { scopedRows, visibleProjects } from './auth.js';

export const tenantId = (credential) => `${credential.orgId}_${credential.projectId}`;
const expressions = {
  cpu: '(100 * (1 - avg(rate(system_cpu_time_seconds_total{state="idle"}[5m])))) or (100 * (1 - avg(rate(system_cpu_time{state="idle"}[5m])))) or avg(pulse_host_cpu_utilization) or avg(pulse_host_cpu_utilization_percent)',
  memory:
    '(100 * sum(system_memory_usage_bytes{state="used"}) / sum(system_memory_usage_bytes)) or (100 * sum(system_memory_usage{state="used"}) / sum(system_memory_usage)) or avg(pulse_host_memory_utilization) or avg(pulse_host_memory_utilization_percent)',
  throughput:
    'sum(rate(http_server_request_duration_seconds_count[5m])) or sum(rate(http_server_request_duration_count[5m]))',
  errors:
    '(100 * sum(rate(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[5m])) / clamp_min(sum(rate(http_server_request_duration_seconds_count[5m])), 1)) or (100 * sum(rate(http_server_request_duration_count{http_response_status_code=~"5.."}[5m])) / clamp_min(sum(rate(http_server_request_duration_count[5m])), 1))',
  latency:
    '(1000 * histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket[5m])))) or (1000 * histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_bucket[5m]))))',
};
export function timeRange(range = '1h') {
  const seconds = { '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400 }[range];
  assert(seconds, 400, 'Choose a range of 15m, 1h, 6h, or 24h.');
  return {
    start: Math.floor(Date.now() / 1000) - seconds,
    end: Math.floor(Date.now() / 1000),
    step: Math.max(15, Math.floor(seconds / 60)),
  };
}
export async function upstream(url, credential, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(15000),
      headers: { ...options.headers, 'X-Scope-OrgID': tenantId(credential) },
    });
  } catch {
    throw new HttpError(503, 'Telemetry storage is unavailable. Check the Docker services.');
  }
  if (!response.ok) {
    const status = response.status === 429 ? 429 : response.status >= 500 ? 503 : 400;
    throw new HttpError(
      status,
      status === 429
        ? 'Telemetry storage is rate limiting requests.'
        : 'Telemetry storage rejected this request. Check format, query, and storage limits.',
    );
  }
  return response;
}
export async function forwardTelemetry(kind, credential, body, contentType) {
  const target = {
    metrics: `${config.MIMIR_URL}/otlp/v1/metrics`,
    logs: `${config.LOKI_URL}/otlp/v1/logs`,
    traces: `${config.TEMPO_OTLP_URL}/v1/traces`,
  }[kind];
  const response = await upstream(target, credential, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
  });
  return {
    body: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || contentType,
  };
}
function demoSeries(range, name) {
  const { start, end, step } = timeRange(range);
  const base = { cpu: 38, memory: 56, throughput: 842, errors: 0.36, latency: 124 }[name];
  const points = [];
  for (let t = start, i = 0; t <= end; t += step, i++)
    points.push({
      time: t * 1000,
      value: +(base * (1 + Math.sin(i / 5) * 0.18 + Math.sin(i * 1.7) * 0.08)).toFixed(2),
    });
  return points;
}
export async function queryTelemetry(store, context, kind, options = {}) {
  const projects = (await visibleProjects(store, context)).filter(
    (p) => !options.projectId || p.id === options.projectId,
  );
  assert(
    projects.length && projects.length <= 20,
    400,
    'Select an accessible project (up to 20 per query).',
  );
  const range = timeRange(options.range);
  if (config.DEMO_MODE) {
    const demoAgents = (await scopedRows(store, context, 'agent')).filter(
      (agent) => agent.demo && (!options.projectId || agent.projectId === options.projectId),
    );
    if (!demoAgents.length) {
      const key = { metrics: 'points', logs: 'entries', traces: 'traces' }[kind];
      return { source: 'demo', [key]: [] };
    }
    if (kind === 'metrics')
      return { source: 'demo', points: demoSeries(options.range || '1h', options.metric || 'cpu') };
    const resources = await scopedRows(store, context, 'monitoredResource', {
      type: 'application',
    });
    const services = resources
      .filter((r) => !options.projectId || r.projectId === options.projectId)
      .map((r) => r.name);
    if (kind === 'logs')
      return {
        source: 'demo',
        entries: Array.from({ length: 80 }, (_, i) => ({
          id: `log-${i}`,
          timestamp: new Date(Date.now() - i * 19000).toISOString(),
          service: services[i % services.length] || 'collector',
          level: i % 13 === 0 ? 'error' : i % 7 === 0 ? 'warn' : 'info',
          message: [
            'Request completed successfully',
            'Database connection pool initialized',
            'Background job processed',
            'Cache hit for session lookup',
            'Health check passed',
            'Payment event received',
            'Retrying upstream request after timeout',
          ][i % 7],
          attributes: {
            'http.method': 'GET',
            'http.route': '/api/orders',
            'http.status_code': i % 13 === 0 ? 503 : 200,
            'duration.ms': 24 + i * 3,
          },
        })).filter(
          (r) =>
            (!options.search ||
              `${r.message} ${r.service}`.toLowerCase().includes(options.search.toLowerCase())) &&
            (!options.level || r.level === options.level) &&
            (!options.service || r.service === options.service),
        ),
      };
    return {
      source: 'demo',
      traces: Array.from({ length: 28 }, (_, i) => ({
        traceId: `${String(i + 10).padStart(32, 'a')}`,
        service: services[i % services.length] || 'api',
        name: ['GET /api/orders', 'POST /api/checkout', 'GET /api/users/me', 'GET /health'][i % 4],
        durationMs: 24 + i * 11,
        spans: 3 + (i % 8),
        status: i % 9 === 0 ? 'error' : 'ok',
        timestamp: new Date(Date.now() - i * 65000).toISOString(),
      })).filter(
        (t) =>
          (!options.search ||
            `${t.name} ${t.service}`.toLowerCase().includes(options.search.toLowerCase())) &&
          (!options.service || t.service === options.service),
      ),
    };
  }
  const results = await Promise.all(
    projects.map(async (project) => {
      const identity = { orgId: context.orgId, projectId: project.id };
      if (kind === 'metrics') {
        const expression = expressions[options.metric || 'cpu'];
        assert(expression, 400, 'Unknown metric preset.');
        const url = new URL(`${config.MIMIR_URL}/prometheus/api/v1/query_range`);
        url.search = new URLSearchParams({ query: expression, ...range }).toString();
        return (await (await upstream(url, identity)).json()).data?.result || [];
      }
      if (kind === 'logs') {
        const selectors = options.service
          ? `service_name=${JSON.stringify(options.service)}`
          : 'service_name=~".+"';
        const query = `{${selectors}}${options.search ? ` |= ${JSON.stringify(options.search)}` : ''}${options.level ? ` | severity_text=~${JSON.stringify(`(?i)${options.level}`)}` : ''}`;
        const url = new URL(`${config.LOKI_URL}/loki/api/v1/query_range`);
        url.search = new URLSearchParams({
          query,
          start: `${range.start}000000000`,
          end: `${range.end}000000000`,
          limit: '200',
          direction: 'backward',
        }).toString();
        const data = await (await upstream(url, identity)).json();
        return (data.data?.result || []).flatMap((s) =>
          s.values.map(([timestamp, message, attributes], i) => ({
            id: `${project.id}-${timestamp}-${i}`,
            timestamp: new Date(Number(BigInt(timestamp) / 1000000n)).toISOString(),
            message,
            level: (attributes?.severity_text || s.stream.severity_text || 'info').toLowerCase(),
            service: s.stream.service_name,
            attributes: { ...s.stream, ...attributes },
          })),
        );
      }
      const url = new URL(`${config.TEMPO_URL}/api/search`);
      const q = options.service
        ? `{ resource.service.name = ${JSON.stringify(options.service)} }`
        : '{}';
      url.search = new URLSearchParams({
        q,
        start: range.start,
        end: range.end,
        limit: '100',
      }).toString();
      const data = await (await upstream(url, identity)).json();
      return (data.traces || []).map((t) => ({
        traceId: t.traceID,
        service: t.rootServiceName,
        name: t.rootTraceName,
        durationMs: Number(t.durationMs),
        spans: t.spanSets?.reduce((a, s) => a + (s.matched || 0), 0) || 0,
        status: 'unknown',
        timestamp: new Date(Number(BigInt(t.startTimeUnixNano) / 1000000n)).toISOString(),
        projectId: project.id,
      }));
    }),
  );
  if (kind === 'metrics') {
    // Preserve distinct project series; aggregate only for a single dashboard plot.
    const series = results.flatMap((rows, i) =>
      rows.map((r) => ({
        projectId: projects[i].id,
        labels: r.metric,
        points: r.values.map(([t, v]) => ({
          time: t * 1000,
          value: Number.isFinite(Number(v)) ? Number(v) : null,
        })),
      })),
    );
    return { source: 'live', series, points: series[0]?.points || [] };
  }
  const entries = results
    .flat()
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 200);
  return { source: 'live', [kind === 'logs' ? 'entries' : 'traces']: entries };
}

// Called for JSON OTLP to discover service metadata. No raw telemetry is persisted here.
export async function discoverServices(store, credential, payload, kind) {
  const key = { metrics: 'resourceMetrics', logs: 'resourceLogs', traces: 'resourceSpans' }[kind];
  for (const group of payload[key] || []) {
    const attributes = Object.fromEntries(
      (group.resource?.attributes || []).map((a) => [a.key, a.value?.stringValue]),
    );
    const name = attributes['service.name'];
    if (
      !name ||
      name === 'pulse-host-agent' ||
      name.length > 100 ||
      name.startsWith('unknown_service')
    )
      continue;
    const type =
      attributes['db.system.name'] || attributes['db.system'] ? 'database' : 'application';
    const environment =
      attributes['deployment.environment.name'] ||
      attributes['deployment.environment'] ||
      'production';
    const existing = await store.find('monitoredResource', {
      orgId: credential.orgId,
      projectId: credential.projectId,
      name,
      type,
    });
    if (existing?.deletedAt) continue;
    if (!existing) {
      const count = (await store.list('monitoredResource', { orgId: credential.orgId, type }))
        .length;
      assert(count < 1000, 429, 'Service discovery resource limit reached.');
      await store.create('monitoredResource', {
        orgId: credential.orgId,
        projectId: credential.projectId,
        name,
        type,
        environment,
        status: 'healthy',
        labels: {
          runtime: attributes['telemetry.sdk.language'] || 'OpenTelemetry',
          engine: attributes['db.system.name'] || attributes['db.system'] || '',
        },
      });
    } else if (existing.status === 'pending')
      await store.update('monitoredResource', existing.id, { status: 'healthy' });
  }
}
