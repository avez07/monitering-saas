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
export async function resolveTarget(target) {
  const url = new URL(target);
  assert(
    ['http:', 'https:', 'tcp:'].includes(url.protocol) && !url.username && !url.password,
    400,
    'Use an HTTP, HTTPS, or TCP URL without credentials.',
  );
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(host, { all: true, verbatim: true });
  assert(
    addresses.length && addresses.every((a) => isPublicAddress(a.address)),
    400,
    'Uptime checks require a publicly routable address.',
  );
  return { url, address: addresses[0] };
}
export async function checkTarget(target) {
  const started = performance.now();
  try {
    const { url, address } = await resolveTarget(target);
    if (url.protocol === 'tcp:')
      return await new Promise((resolve) => {
        const socket = createConnection({
          host: address.address,
          port: Number(url.port || 443),
          timeout: 8000,
        });
        const finish = (ok, error) => {
          socket.destroy();
          resolve({
            ok,
            latencyMs: Math.round(performance.now() - started),
            statusCode: ok ? 200 : 0,
            error,
          });
        };
        socket.once('connect', () => finish(true));
        socket.once('error', (e) => finish(false, e.code));
        socket.once('timeout', () => finish(false, 'Timeout'));
      });
    return await new Promise((resolve) => {
      const transport = url.protocol === 'https:' ? https : http;
      const request = transport.request(
        url,
        {
          method: 'GET',
          timeout: 8000,
          lookup: (host, options, callback) =>
            options?.all
              ? callback(null, [address])
              : callback(null, address.address, address.family),
          headers: { 'user-agent': 'YuktiOpsUptime/0.1', range: 'bytes=0-1023' },
        },
        (response) => {
          const certificate = response.socket.getPeerCertificate?.();
          const expiresAt = certificate?.valid_to
            ? new Date(certificate.valid_to).toISOString()
            : null;
          const result = {
            ok: response.statusCode >= 200 && response.statusCode < 400,
            statusCode: response.statusCode,
            latencyMs: Math.round(performance.now() - started),
            certificateExpiresAt: expiresAt,
          };
          response.destroy();
          resolve(result);
        },
      );
      request.on('error', (error) =>
        resolve({
          ok: false,
          statusCode: 0,
          latencyMs: Math.round(performance.now() - started),
          error: error.code || error.message,
        }),
      );
      request.on('timeout', () => request.destroy(new Error('Timeout')));
      request.end();
    });
  } catch (error) {
    return { ok: false, statusCode: 0, latencyMs: 0, error: error.message };
  }
}
