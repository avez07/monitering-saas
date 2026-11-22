// Pure parser for pasted `curl` commands. No DOM or React here so it is easy to test.

/** Split a shell-style command into words, honouring quotes and line continuations. */
export function tokenize(input) {
  // Join continued lines: \ (sh), ^ (cmd) or ` (PowerShell) at end of line.
  const text = String(input)
    .replace(/\r\n?/g, '\n')
    .replace(/(?:\\|\^|`)[ \t]*\n/g, ' ');
  const tokens = [];
  let cur = '';
  let has = false;
  let i = 0;
  const push = () => {
    if (has) tokens.push(cur);
    cur = '';
    has = false;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === "'") {
      has = true;
      i++;
      while (i < text.length && text[i] !== "'") cur += text[i++];
      i++;
    } else if (c === '"') {
      has = true;
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1])) i++;
        cur += text[i++];
      }
      i++;
    } else if (c === '$' && text[i + 1] === "'") {
      // ANSI-C quoting: $'...'
      has = true;
      i += 2;
      while (i < text.length && text[i] !== "'") {
        if (text[i] === '\\' && i + 1 < text.length) {
          const n = text[i + 1];
          cur += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
          i += 2;
        } else cur += text[i++];
      }
      i++;
    } else if (c === '\\' && i + 1 < text.length) {
      has = true;
      cur += text[i + 1];
      i += 2;
    } else if (/\s/.test(c)) {
      push();
      i++;
    } else {
      has = true;
      cur += c;
      i++;
    }
  }
  push();
  return tokens;
}

const IGNORED_FLAGS = new Set([
  '--compressed', '-s', '--silent', '-S', '--show-error', '-k', '--insecure', '-L', '--location',
  '-v', '--verbose', '-i', '--include', '-f', '--fail', '-g', '--globoff', '--http1.1', '--http2',
  '-N', '--no-buffer', '-#', '--progress-bar', '-4', '-6', '--location-trusted',
]);
// Flags that take a value we do not use.
const IGNORED_WITH_VALUE = new Set([
  '-o', '--output', '-m', '--max-time', '--connect-timeout', '-A', '--user-agent', '-e', '--referer',
  '--retry', '-w', '--write-out', '-x', '--proxy', '--cacert', '--cert', '--key', '-b', '--cookie',
]);
const DATA_FLAGS = new Set([
  '-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '--json',
]);

function appendQuery(url, pairs) {
  if (!pairs.length) return url;
  const hash = url.indexOf('#');
  const base = hash >= 0 ? url.slice(0, hash) : url;
  const frag = hash >= 0 ? url.slice(hash) : '';
  return `${base}${base.includes('?') ? '&' : '?'}${pairs.join('&')}${frag}`;
}

function toBase64(text) {
  try {
    return btoa(text);
  } catch {
    return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  }
}

const hasHeader = (headers, name) =>
  Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());

/**
 * Parse a curl command.
 * Returns { ok, error?, method, url, headers: {name: value}, query: {k: v}, body, warnings[] }.
 */
export function parseCurl(input) {
  const tokens = tokenize(input || '');
  if (!tokens.length) return { ok: false, error: 'Paste a curl command first.' };
  let start = 0;
  if (/^(\$|>|#)$/.test(tokens[0])) start = 1;
  if (tokens[start] !== 'curl' && tokens[start] !== 'curl.exe')
    return { ok: false, error: 'This does not start with "curl".' };

  let method = null;
  let url = '';
  let getMode = false;
  let head = false;
  let auth = null;
  let jsonMode = false;
  const headers = {};
  const dataParts = [];
  const warnings = [];

  const addHeader = (raw) => {
    const i = raw.indexOf(':');
    if (i <= 0) return;
    const name = raw.slice(0, i).trim();
    for (const k of Object.keys(headers)) if (k.toLowerCase() === name.toLowerCase()) delete headers[k];
    headers[name] = raw.slice(i + 1).trim();
  };

  for (let i = start + 1; i < tokens.length; i++) {
    let t = tokens[i];
    let inline = null;
    if (t.startsWith('--') && t.includes('=')) {
      inline = t.slice(t.indexOf('=') + 1);
      t = t.slice(0, t.indexOf('='));
    }
    const value = () => (inline !== null ? inline : (tokens[++i] ?? ''));

    if (t === '-X' || t === '--request') method = value().toUpperCase();
    else if (t.startsWith('-X') && !t.startsWith('--')) method = t.slice(2).toUpperCase();
    else if (t === '--url') url = value();
    else if (t === '-H' || t === '--header') addHeader(value());
    else if (t.startsWith('-H') && !t.startsWith('--')) addHeader(t.slice(2));
    else if (DATA_FLAGS.has(t)) {
      const v = value();
      if (t === '--json') jsonMode = true;
      if (v.startsWith('@') && t !== '--data-raw')
        warnings.push('Reading the body from a file (@file) is not supported. Paste the body into the form.');
      else dataParts.push(v);
    } else if (t === '-G' || t === '--get') getMode = true;
    else if (t === '-I' || t === '--head') head = true;
    else if (t === '-u' || t === '--user') auth = value();
    else if (t === '--oauth2-bearer') headers.Authorization = `Bearer ${value()}`;
    else if (t === '-F' || t === '--form') {
      value();
      warnings.push('Multipart form fields (-F) are not supported and were skipped.');
    } else if (IGNORED_FLAGS.has(t)) continue;
    else if (IGNORED_WITH_VALUE.has(t)) value();
    else if (t.startsWith('-') && t.length > 1) warnings.push(`Ignored option ${t}.`);
    else if (!url) url = t;
  }

  if (!url) return { ok: false, error: 'No address (URL) found in that command.' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url))
    url = `${/^(localhost|\d+\.\d+\.\d+\.\d+)/.test(url) ? 'http' : 'https'}://${url}`;

  if (auth !== null && !hasHeader(headers, 'authorization'))
    headers.Authorization = `Basic ${toBase64(auth)}`;
  if (jsonMode) {
    if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json';
    if (!hasHeader(headers, 'accept')) headers.Accept = 'application/json';
  }

  let body = null;
  if (getMode) url = appendQuery(url, dataParts);
  else if (dataParts.length) body = dataParts.join('&');

  if (!method) method = head ? 'HEAD' : body !== null ? 'POST' : 'GET';

  const query = {};
  const hashIndex = url.indexOf('#');
  const qIndex = url.indexOf('?');
  if (qIndex >= 0) {
    const raw = url.slice(qIndex + 1, hashIndex > qIndex ? hashIndex : undefined);
    for (const [k, v] of new URLSearchParams(raw)) query[k] = v;
  }

  return { ok: true, method, url, headers, query, body, warnings };
}

/** Header object to the "Name: value" lines used by the form. */
export const headersToLines = (headers) =>
  Object.entries(headers || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
