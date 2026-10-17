export const session = {
  get token() {
    return localStorage.getItem('pulse.token');
  },
  set token(value) {
    value ? localStorage.setItem('pulse.token', value) : localStorage.removeItem('pulse.token');
  },
  get org() {
    return localStorage.getItem('pulse.org');
  },
  set org(value) {
    value ? localStorage.setItem('pulse.org', value) : localStorage.removeItem('pulse.org');
  },
};
export function url(path, params = {}) {
  const query = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined),
  );
  return `/api${path}${query.size ? `?${query}` : ''}`;
}
export async function api(path, { method = 'GET', body, params, text = false } = {}) {
  const response = await fetch(url(path, params), {
    method,
    headers: {
      ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}),
      ...(session.org ? { 'X-Organization-Id': session.org } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'The API is unavailable.' }));
    if (response.status === 401 && !path.startsWith('/auth'))
      window.dispatchEvent(new Event('pulse:logout'));
    throw new Error(error.error || `Request failed (${response.status}).`);
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
