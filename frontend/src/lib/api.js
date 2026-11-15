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
export async function api(path, { method = 'GET', body, params, text = false } = {}) {
  const response = await fetch(url(path, params), {
    method,
    credentials: 'same-origin',
    headers: {
      ...(session.org ? { 'X-Organization-Id': session.org } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'The API is unavailable.' }));
    if (response.status === 401 && !path.startsWith('/auth'))
      window.dispatchEvent(new Event('yuktiops:logout'));
    const failure = new Error(error.error || `Request failed (${response.status}).`);
    failure.status = response.status;
    throw failure;
  }
  if (response.status === 204) return null;
  return text ? response.text() : response.json();
}

export function download(name, content, type = 'text/plain') {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
