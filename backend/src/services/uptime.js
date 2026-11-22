import { lookup } from 'node:dns/promises';
import { isIP, createConnection } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { assert } from '../lib/errors.js';

export function isPublicAddress(address) {
  if (isIP(address) === 6)
    // Global unicast only. Exclude documentation (2001:db8), Teredo (2001:0::/32) and 6to4 (2002::/16),
    // which can embed or tunnel to private IPv4 addresses.
    return /^[23][0-9a-f]{3}:/i.test(address) && !/^(2001:(db8|0*0):|2002:)/i.test(address);
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || b === 2)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

// Test-only escape hatch: lets integration tests talk to a fake server on 127.0.0.1. Production never
// calls this, and it only ever opens loopback, not private networks or cloud metadata addresses.
let loopbackForTests = false;
export function allowLoopbackForTests(on = true) {
  loopbackForTests = on;
}
const addressAllowed = (address) =>
  isPublicAddress(address) || (loopbackForTests && (address === '127.0.0.1' || address === '::1'));

/** Resolve a URL's host and refuse anything that is not a public address. */
export async function resolveTarget(target, protocols = ['http:', 'https:', 'tcp:']) {
  let url;
  try {
    url = new URL(target);
  } catch {
    assert(false, 400, 'Enter a valid address.');
  }
  assert(
    protocols.includes(url.protocol) && !url.username && !url.password,
    400,
    'Use an HTTP or HTTPS address without a username or password.',
  );
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    assert(false, 400, 'We could not find that address (DNS lookup failed).');
  }
  assert(
    addresses.length && addresses.every((a) => addressAllowed(a.address)),
    400,
    'Checks require a publicly routable address.',
  );
  return { url, address: addresses[0] };
}

const codeOf = (error) => {
  const code = error?.code || error?.message || 'error';
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return 'dns';
  if (/ECONNREFUSED/.test(code)) return 'connection_refused';
  if (/ECONNRESET|EPIPE/.test(code)) return 'connection_reset';
  if (/ETIMEDOUT|timeout/i.test(code)) return 'timeout';
  if (/CERT|TLS|SSL|DEPTH_ZERO|UNABLE_TO_VERIFY|ERR_TLS/i.test(code)) return 'tls';
  return String(code).slice(0, 60);
};
export const errorCode = codeOf;

/**
 * One guarded HTTP(S) request. The host is resolved once, vetted, and then pinned for the connection,
 * so DNS rebinding between the check and the connect cannot reach a private address. Redirects are only
 * followed when asked, and every hop is vetted again.
 * Returns { status, headers, body, latencyMs, certificateExpiresAt }; throws an Error whose `.code` is short.
 */
export async function safeRequest(target, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 8000,
    maxBytes = 0,
    maxRedirects = 0,
  } = options;
  const started = performance.now();
  let current = target;
  for (let hop = 0; ; hop++) {
    const result = await once(current, { method, headers, body, timeoutMs, maxBytes });
    const location = result.headers.location;
    if (result.status >= 300 && result.status < 400 && location && hop < maxRedirects) {
      current = new URL(location, current).toString();
      continue;
    }
    return { ...result, latencyMs: Math.round(performance.now() - started) };
  }
}


async function once(
  target,
  { method, headers, body, timeoutMs, maxBytes = 10240 },
) {
  const { url, address } = await resolveTarget(target, ['http:', 'https:']);

  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;

    const request = transport.request(
      url,
      {
        method,
        timeout: timeoutMs,
        lookup: (host, opts, callback) =>
          opts?.all
            ? callback(null, [address])
            : callback(null, address.address, address.family),
        headers: {
          'user-agent': 'YuktiOpsUptime/1.0',
          ...headers,
          ...(body != null
            ? { 'content-length': Buffer.byteLength(body) }
            : {}),
        },
      },
      (response) => {
        const chunks = [];
        let size = 0;
        let completed = false;
        // console.log(body)

        const certificate = response.socket.getPeerCertificate?.();

        const certificateExpiresAt = certificate?.valid_to
          ? new Date(certificate.valid_to).toISOString()
          : null;

        const getBody = () => Buffer.concat(chunks).toString('utf8');

        const done = () => {
          if (completed) return;
          completed = true;

          const responseBody = getBody();
console.log('headers:', headers);
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: responseBody,
            certificateExpiresAt,
          });
        };

        response.on('data', (chunk) => {
          const remaining = Math.max(0, maxBytes - size);

          if (remaining > 0) {
            chunks.push(chunk.subarray(0, remaining));
          }

          size += chunk.length;
        });

        response.on('end', done);

        response.on('aborted', () => {
          console.error('Response aborted');
          done();
        });

        response.on('error', (error) => {
          console.error('Response error:', error);
          done();
        });

        response.on('close', done);
      },
    );

    request.on('error', (error) => {
      console.error('Request error:', error);

      reject(
        Object.assign(new Error(codeOf(error)), {
          code: codeOf(error),
        }),
      );
    });

    request.on('timeout', () => {
      request.destroy(
        Object.assign(new Error('timeout'), { code: 'timeout' }),
      );
    });

    request.end(body ?? undefined);
  });
}



/** Open a TCP connection to a vetted public address. Resolves with latency or rejects with a short code. */
export async function tcpConnect(host, port, timeoutMs = 8000) {
  const started = performance.now();
  const { address } = await resolveTarget(
    `tcp://${host.includes(':') ? `[${host}]` : host}:${port}`,
  );
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: address.address, port, timeout: timeoutMs });
    socket.once('connect', () => {
      socket.destroy();
      resolve({ latencyMs: Math.round(performance.now() - started) });
    });
    socket.once('error', (e) => {
      socket.destroy();
      reject(Object.assign(new Error(codeOf(e)), { code: codeOf(e) }));
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(Object.assign(new Error('timeout'), { code: 'timeout' }));
    });
  });
}
