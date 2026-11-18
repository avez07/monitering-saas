import { randomUUID } from 'node:crypto';

/** An error the caller can act on. `code` is a stable machine name (see docs/api/errors.md). */
export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    if (extra.code) this.code = extra.code;
    if (extra.hint) this.hint = extra.hint;
    if (extra.service) this.service = extra.service;
  }
}
export function assert(condition, status, message) {
  if (!condition) throw new HttpError(status, message);
}

// --- secrets -----------------------------------------------------------------------------------

const SECRET_PATTERNS = [
  [/\b(yk_(?:live|test)_|st_|ykt_|tk_)[A-Za-z0-9_-]{8,}/g, '$1[redacted]'], // API keys, setup ids, telemetry keys
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s@]+)@/gi, '$1$2:[redacted]@'], // user:password@ in URLs
  [/\b(password|passwd|pwd|secret|token|api[_-]?key|authorization)(["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi, '$1$2[redacted]'],
];
/** Remove API keys, bearer tokens and passwords from text before it is logged or sent to a browser. */
export function redact(text) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

// --- classification ----------------------------------------------------------------------------

const NETWORK_CODES = {
  ECONNREFUSED: ['upstream_refused', 502, 'Connection refused: nothing is listening at that address and port.'],
  ECONNRESET: ['upstream_reset', 502, 'The connection was reset by the other side.'],
  ENOTFOUND: ['upstream_dns_failed', 502, 'The host name could not be resolved (DNS failure).'],
  EAI_AGAIN: ['upstream_dns_failed', 502, 'The host name could not be resolved (DNS failure).'],
  EHOSTUNREACH: ['upstream_unreachable', 502, 'The host is unreachable.'],
  ENETUNREACH: ['upstream_unreachable', 502, 'The network is unreachable.'],
  ETIMEDOUT: ['upstream_timeout', 504, 'The connection timed out.'],
  ESOCKETTIMEDOUT: ['upstream_timeout', 504, 'The connection timed out.'],
  UND_ERR_CONNECT_TIMEOUT: ['upstream_timeout', 504, 'The connection timed out.'],
};
const PRISMA_UNREACHABLE = new Set(['P1000', 'P1001', 'P1002', 'P1008', 'P1017']);
const HINTS = {
  database_unreachable: 'Check that PostgreSQL is running and DATABASE_URL points to it (docker compose up -d db).',
  database_timeout: 'The database is overloaded or the connection pool is exhausted. Retry; check PgBouncer and slow queries.',
  database_out_of_date: 'Run the migrations: npm run db:migrate.',
  database_auth_failed: 'The database refused the configured user or password. Check DATABASE_URL.',
  redis_unreachable: 'Check that Redis is running and REDIS_URL points to it (docker compose up -d redis).',
  upstream_refused: 'Check that the target service is running and the host and port are right.',
  upstream_timeout: 'The target did not answer in time. Check the network, firewall and the target’s load.',
  upstream_dns_failed: 'Check the host name and the DNS settings of the machine the API runs on.',
  upstream_reset: 'The target closed the connection. Check its logs.',
  upstream_unreachable: 'Check the network route and firewall between the API and the target.',
  upstream_tls_failed: 'Check the target’s certificate (expired, wrong host name or unknown issuer).',
  upstream_auth_failed: 'The target rejected the credential. Check the configured key, token or password.',
  internal_error: 'This is a bug on our side. Quote the error id when you report it.',
};

const isRedis = (e) =>
  ['MaxRetriesPerRequestError', 'ReplyError', 'ConnectionTimeoutError'].includes(e.name) ||
  /\bredis\b|ECONNREFUSED[^\n]*:6379/i.test(e.message || '');

/**
 * Work out what a thrown value means. Returns { status, code, message, cause?, service?, hint? }.
 * `cause` is a redacted, short technical reason; the full error only goes to the server log.
 * Only genuinely unexpected errors become 500 `internal_error`.
 */
export function classifyError(error) {
  if (error?.name === 'ZodError')
    return {
      status: 400,
      code: 'validation_failed',
      message: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  if (error instanceof HttpError || (Number.isInteger(error?.status) && error.status < 500 && error.status >= 400)) {
    return {
      status: error.status,
      code: error.code && typeof error.code === 'string' ? error.code : defaultCode(error.status),
      message: redact(error.message),
      ...(error.hint ? { hint: error.hint } : {}),
      ...(error.service ? { service: error.service } : {}),
    };
  }
  if (error?.code === 'P2002') return { status: 409, code: 'conflict', message: 'This already exists.' };
  const raw = redact(error?.message || String(error));
  const cause = raw.split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 240) || undefined;
  const out = (status, code, message, service) => ({ status, code, message, cause, service, hint: HINTS[code] });

  if (error?.code === 'P2021' || error?.code === 'P2022')
    return out(503, 'database_out_of_date', 'The database schema is out of date.', 'database');
  if (error?.code === 'P2024') return out(504, 'database_timeout', 'Timed out waiting for a database connection.', 'database');
  if (PRISMA_UNREACHABLE.has(error?.code) || /Can't reach database server/i.test(raw))
    return out(503, 'database_unreachable', 'The database is not reachable.', 'database');
  if (/password authentication failed|authentication failed against database/i.test(raw))
    return out(503, 'database_auth_failed', 'The database refused the configured credentials.', 'database');
  if (isRedis(error)) return out(503, 'redis_unreachable', 'Redis is not reachable.', 'redis');

  if (error?.name === 'AbortError' || error?.name === 'TimeoutError')
    return out(504, 'upstream_timeout', 'A request to another service timed out.', undefined);
  const net = NETWORK_CODES[error?.code] || NETWORK_CODES[error?.cause?.code];
  if (net) return out(net[1], net[0], net[2], undefined);
  if (/certificate|self[- ]signed|SSL routines|TLS/i.test(raw) && /CERT_|UNABLE_TO|DEPTH_ZERO|ERR_TLS|SSL/i.test(`${error?.code} ${raw}`))
    return out(502, 'upstream_tls_failed', 'The secure connection to another service failed.', undefined);
  return out(500, 'internal_error', 'The service could not complete this request.', undefined);
}

function defaultCode(status) {
  return (
    { 400: 'bad_request', 401: 'unauthorized', 402: 'payment_required', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 413: 'payload_too_large', 422: 'unprocessable', 429: 'rate_limited' }[status] ||
    'request_failed'
  );
}

/** Build the JSON body sent to the client. `error` stays the plain message for older callers. */
export function errorBody(info, { errorId } = {}) {
  return {
    error: info.message,
    code: info.code,
    message: info.message,
    ...(info.service ? { service: info.service } : {}),
    ...(info.cause && info.status >= 500 ? { cause: info.cause } : {}),
    timestamp: new Date().toISOString(),
    ...(info.hint ? { hint: info.hint } : {}),
    ...(errorId ? { errorId } : {}),
  };
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const info = classifyError(error);
  const errorId = info.status >= 500 ? randomUUID().slice(0, 8) : undefined;
  // Full detail (with stack, secrets redacted) goes to the server log only, never to the client.
  if (info.status >= 500)
    console.error(`[${req.method} ${req.path}] ${info.code} id=${errorId}`, redact(error?.stack || error?.message || String(error)));
  if (info.status === 503 || info.status === 429) res.set('Retry-After', '5');
  res.status(info.status).json({
    ...errorBody(info, { errorId }),
    ...(info.status < 500 && error.reason ? { reason: error.reason } : {}),
  });
}
