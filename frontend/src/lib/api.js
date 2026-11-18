// The session lives in an httpOnly cookie that page scripts cannot read. Only the selected
// organization (not a secret) is remembered in the browser.
export const session = {
  get org() {
    try {
      return localStorage.getItem('yuktiops.org');
    } catch {
      return null;
    }
  },
  set org(value) {
    try {
      if (value) localStorage.setItem('yuktiops.org', value);
      else localStorage.removeItem('yuktiops.org');
    } catch {
      /* storage can be unavailable in private windows */
    }
  },
};

export function url(path, params = {}) {
  const query = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined),
  );
  return `/api${path}${query.size ? `?${query}` : ''}`;
}

/**
 * Call the API (same-origin, cookie session). Throws Error(message) using the API's
 * `{ error }` body (error.status holds the HTTP status). A 401 outside /auth fires
 * `yuktiops:logout`, which the SessionProvider handles.
 */
export const REQUEST_TIMEOUT_MS = 30000;

/** Plain-language message for an error response that had no JSON `{ error }` body. */
export function statusMessage(status) {
  if (status === 404) return 'This action is not available on the server (404).';
  if (status === 502 || status === 503 || status === 504)
    return `The API is unreachable (${status}). Please try again in a moment.`;
  if (status === 429) return 'Too many requests. Please wait a moment and try again.';
  if (status >= 500) return `The server hit an error (${status}). Please try again.`;
  return `Request failed (${status}).`;
}

export async function api(
  path,
  { method = 'GET', body, params, text = false, timeoutMs = REQUEST_TIMEOUT_MS } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(url(path, params), {
        method,
        credentials: 'same-origin',
        signal: controller.signal,
        headers: {
          ...(session.org ? { 'X-Organization-Id': session.org } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (cause) {
      const failure = new Error(
        cause?.name === 'AbortError'
          ? 'The request took too long and was stopped. Please try again.'
          : 'Could not reach the API. Check your connection and try again.',
      );
      failure.status = 0;
      throw failure;
    }
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      if (response.status === 401 && !path.startsWith('/auth'))
        window.dispatchEvent(new Event('yuktiops:logout'));
      const failure = new Error(error?.error || statusMessage(response.status));
      failure.status = response.status;
      // Structured details from the API (see docs/api/errors.md): shown by ErrorState.
      if (error && typeof error === 'object')
        failure.details = {
          code: error.code,
          cause: error.cause,
          hint: error.hint,
          service: error.service,
          timestamp: error.timestamp,
          errorId: error.errorId,
        };
      throw failure;
    }
    if (response.status === 204) return null;
    return await (text ? response.text() : response.json());
  } finally {
    clearTimeout(timer);
  }
}

export function download(name, content, type = 'text/plain') {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
