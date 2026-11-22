import { config } from '../config.js';
import { HttpError } from './errors.js';

/**
 * VictoriaMetrics (single node) access: remote_write in, PromQL out. Every read goes through `vmQuery`,
 * which always adds `extra_label=yk_org=<orgId>`, so one organization can never read another's series.
 */
let override = null;
/** Point at another VictoriaMetrics (tests use a local mock server). Pass null to go back to VM_URL. */
export const configureVictoria = ({ url } = {}) => void (override = url || null);
export const vmUrl = () => (override || config.VM_URL).replace(/\/+$/, '');

export const QUERY_TIMEOUT_MS = 10000;
const WRITE_TIMEOUT_MS = 15000;

/** POST one snappy-compressed remote_write body. Throws with `permanent: true` when retrying cannot help. */
export async function vmWrite(body) {
  const response = await fetch(`${vmUrl()}/api/v1/write`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-protobuf',
      'Content-Encoding': 'snappy',
      'X-Prometheus-Remote-Write-Version': '0.1.0',
    },
    body,
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  });
  if (response.ok) return;
  const text = (await response.text().catch(() => '')).slice(0, 300);
  const error = new Error(`VictoriaMetrics write answered ${response.status}: ${text}`);
  error.permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
  throw error;
}

const unavailable = () =>
  new HttpError(503, 'Metrics storage is unavailable. Try again shortly.', {
    code: 'metrics_unavailable',
    service: 'victoriametrics',
  });

/**
 * Run `/api/v1/<endpoint>` (query, query_range, series, labels...) for one organization. `params` are the
 * already validated query parameters; the tenant label is always added here. Returns the Prometheus API
 * JSON body. A bad query becomes 400, a timeout 504, storage trouble 503.
 */
export async function vmQuery(orgId, endpoint, params, { timeoutMs = QUERY_TIMEOUT_MS } = {}) {
  if (!orgId) throw new Error('vmQuery needs an organization id.');
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) search.append(key, String(value));
  search.set('extra_label', `yk_org=${orgId}`);
  search.set('timeout', `${Math.ceil(timeoutMs / 1000)}s`);
  let response;
  try {
    response = await fetch(`${vmUrl()}/api/v1/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: search.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError')
      throw new HttpError(504, `The query took longer than ${timeoutMs / 1000} seconds. Use a shorter range or a simpler query.`, {
        code: 'query_timeout',
        service: 'victoriametrics',
      });
    console.error('victoria: query failed:', error.message);
    throw unavailable();
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.ok && body?.status === 'success') return body;
  if ([400, 422].includes(response.status))
    throw new HttpError(400, `The query could not be run: ${String(body?.error || 'invalid query').slice(0, 300)}`, { code: 'bad_query' });
  if (response.status === 503 && /timeout|deadline/i.test(String(body?.error)))
    throw new HttpError(504, 'The query took too long. Use a shorter range or a simpler query.', { code: 'query_timeout', service: 'victoriametrics' });
  console.error(`victoria: query answered ${response.status}:`, String(body?.error || '').slice(0, 200));
  throw unavailable();
}
