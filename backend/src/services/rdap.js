import { isIP } from 'node:net';
import { safeRequest } from './uptime.js';

const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const SECOND_LEVEL = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.in', 'net.in',
  'org.in', 'com.br', 'co.za', 'co.jp', 'com.sg', 'com.cn', 'com.mx', 'com.tr',
]);

/** The registrable part of a host name ("www.shop.example.co.uk" -> "example.co.uk"), or null for IPs. */
export function registrableDomain(host) {
  const name = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!name || isIP(name) || name === 'localhost' || !name.includes('.')) return null;
  const labels = name.split('.');
  const tail2 = labels.slice(-2).join('.');
  const keep = SECOND_LEVEL.has(tail2) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

/** Pull the expiry date out of an RDAP domain response. */
export function parseRdapExpiry(json) {
  const event = (json?.events || []).find((e) => /expir/i.test(e.eventAction || ''));
  const date = event?.eventDate ? new Date(event.eventDate) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

/** Find the RDAP base URL for a TLD in the IANA bootstrap file. */
export function rdapServerFor(bootstrap, tld) {
  for (const [tlds, urls] of bootstrap?.services || [])
    if (tlds.map((t) => t.toLowerCase()).includes(tld.toLowerCase()) && urls?.length)
      return urls.find((u) => u.startsWith('https://')) || urls[0];
  return null;
}

const defaultFetchJson = async (url) => {
  const response = await safeRequest(url, {
    timeoutMs: 8000,
    maxBytes: 1_000_000,
    maxRedirects: 3,
    headers: { accept: 'application/rdap+json, application/json' },
  });
  if (response.status === 404) return null;
  if (response.status !== 200) throw new Error(`status_${response.status}`);
  return JSON.parse(response.body);
};

let bootstrapCache = { at: 0, data: null };
export function resetRdapCache() {
  bootstrapCache = { at: 0, data: null };
}

/**
 * Look up when a domain expires. Never throws: TLDs without RDAP report `unsupported`, and network
 * problems report `error` so the caller can retry later.
 */
export async function lookupDomainExpiry(domain, { fetchJson = defaultFetchJson, now = Date.now() } = {}) {
  try {
    if (!bootstrapCache.data || now - bootstrapCache.at > 86400000)
      bootstrapCache = { at: now, data: await fetchJson(BOOTSTRAP_URL) };
    const server = rdapServerFor(bootstrapCache.data, domain.split('.').pop());
    if (!server) return { status: 'unsupported', expiresAt: null };
    const json = await fetchJson(`${server.replace(/\/$/, '')}/domain/${encodeURIComponent(domain)}`);
    const expiresAt = parseRdapExpiry(json);
    return expiresAt ? { status: 'ok', expiresAt } : { status: 'unsupported', expiresAt: null };
  } catch (error) {
    return { status: 'error', expiresAt: null, error: error.message };
  }
}

/** Refresh domain expiry for websites that have not been looked up in the last day (a week if unsupported). */
export async function refreshDomainExpiry(store, { now = Date.now(), fetchJson, limit = 20 } = {}) {
  const monitors = await store.client.uptimeMonitor.findMany({
    where: { enabled: true, domain: { not: null }, type: { not: 'tcp' } },
  });
  const due = monitors
    .filter((m) => {
      const age = m.domainCheckedAt ? now - new Date(m.domainCheckedAt).getTime() : Infinity;
      const wait = { unsupported: 7 * 86400000, error: 3600000 }[m.domainStatus] ?? 86400000;
      return age > wait;
    })
    .slice(0, limit);
  for (const monitor of due) {
    const result = await lookupDomainExpiry(monitor.domain, { fetchJson, now });
    await store.update('uptimeMonitor', monitor.id, {
      domainCheckedAt: new Date(now),
      domainStatus: result.status,
      ...(result.expiresAt ? { domainExpiresAt: result.expiresAt } : {}),
    });
  }
  return due.length;
}
