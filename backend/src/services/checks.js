import { safeRequest, tcpConnect, errorCode } from './uptime.js';

export const RETRY_DELAY_SECONDS = 30;

/** Days from `now` until `date` (rounded down; negative when already past), or null. */
export function daysLeft(date, now = Date.now()) {
  if (!date) return null;
  return Math.floor((new Date(date).getTime() - now) / 86400000);
}
/** 30, 14 or 7 for the warning band, 0 once expired, null when there is nothing to warn about. */
export function warningBand(days) {
  if (days == null) return null;
  if (days < 0) return 0;
  if (days <= 7) return 7;
  if (days <= 14) return 14;
  if (days <= 30) return 30;
  return null;
}

export const tcpTarget = (host, port) => `tcp://${host.includes(':') ? `[${host}]` : host}:${port}`;
export function hostOf(target) {
  try {
    return new URL(target).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

function failureCode(error) {
  if (error?.status === 400) return /DNS/.test(error.message) ? 'dns' : 'blocked_address';
  return errorCode(error);
}

/**
 * Run one check. Never throws; returns { ok, statusCode, latencyMs, error, certificateExpiresAt }.
 * `deps.request` / `deps.connect` replace the network calls in tests.
 */
export async function runCheck(monitor, deps = {}) {
  const request = deps.request ?? safeRequest;
  const connect = deps.connect ?? tcpConnect;
  const timeoutMs = (monitor.timeoutSeconds || 10) * 1000;
  const started = performance.now();
  try {
    if (monitor.type === 'tcp') {
      const url = new URL(monitor.target);
      const { latencyMs } = await connect(hostOf(monitor.target), Number(url.port), timeoutMs);
      return { ok: true, statusCode: 0, latencyMs, error: null, certificateExpiresAt: null };
    }
    const isApi = monitor.type === 'api';
    const readsBody = monitor.type === 'keyword' || (isApi && !!monitor.jsonContains);
    const response = await request(monitor.target, {
      method: isApi ? monitor.method : 'GET',
      headers: isApi ? monitor.headers || {} : {},
      body: isApi && monitor.body ? monitor.body : undefined,
      timeoutMs,
      maxBytes: readsBody ? 256 * 1024 : 0,
      maxRedirects: monitor.type === 'http' ? 0 : 3,
    });
    const status = response.status;
    let error = null;
    const statusOk =
      monitor.expectedStatus != null
        ? status === monitor.expectedStatus
        : status >= 200 && status < (isApi ? 300 : 400);
    if (!statusOk) error = `status_${status}`;
    else if (monitor.type === 'keyword') {
      const found = (response.body || '').toLowerCase().includes(monitor.keyword.toLowerCase());
      if (monitor.keywordMode === 'absent' ? found : !found)
        error = monitor.keywordMode === 'absent' ? 'keyword_found' : 'keyword_missing';
    } else if (isApi && monitor.jsonContains && !(response.body || '').includes(monitor.jsonContains))
      error = 'json_missing';
    return {
      ok: !error,
      statusCode: status,
      latencyMs: response.latencyMs ?? Math.round(performance.now() - started),
      error,
      certificateExpiresAt: response.certificateExpiresAt ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 0,
      latencyMs: Math.round(performance.now() - started),
      error: failureCode(error),
      certificateExpiresAt: null,
    };
  }
}

/**
 * Store one result and move the monitor through its states. A failure only counts as "down" after
 * `failureThreshold` consecutive failures; until then the site keeps its status and is re-checked quickly.
 */
export async function recordCheckResult(store, monitor, result, resource, now = Date.now()) {
  const at = new Date(now);
  const failures = result.ok ? 0 : (monitor.consecutiveFailures || 0) + 1;
  const status = result.ok
    ? 'healthy'
    : failures >= monitor.failureThreshold
      ? 'unhealthy'
      : monitor.status === 'unhealthy'
        ? 'unhealthy'
        : monitor.status;
  const retrying = !result.ok && status !== 'unhealthy';
  const delay = retrying ? Math.min(monitor.intervalSeconds, RETRY_DELAY_SECONDS) : monitor.intervalSeconds;
  const certificateExpiresAt = result.certificateExpiresAt
    ? new Date(result.certificateExpiresAt)
    : monitor.type === 'tcp'
      ? null
      : monitor.certificateExpiresAt;
  await store.create('uptimeCheck', {
    orgId: monitor.orgId,
    monitorId: monitor.id,
    ok: result.ok,
    statusCode: result.statusCode,
    latencyMs: result.latencyMs,
    certificateExpiresAt: result.certificateExpiresAt ? new Date(result.certificateExpiresAt) : null,
    error: result.error,
    createdAt: at,
  });
  await store.update('uptimeMonitor', monitor.id, {
    status,
    consecutiveFailures: failures,
    latencyMs: result.latencyMs,
    lastCheckedAt: at,
    nextCheckAt: new Date(now + delay * 1000),
    certificateExpiresAt,
    lastError: result.ok ? null : result.error,
    downSince: status === 'unhealthy' ? (monitor.downSince ?? at) : null,
  });
  if (resource)
    await store.update('monitoredResource', resource.id, {
      status: status === 'unhealthy' ? 'unhealthy' : 'healthy',
      labels: {
        latency: result.latencyMs,
        availability: status === 'unhealthy' ? 0 : 1,
        certificateDays: daysLeft(certificateExpiresAt, now),
      },
    });
  return status;
}

/** Make sure a website has the resource row incidents and the overview refer to. */
export async function ensureResource(store, monitor, existing) {
  if (existing) {
    if (existing.name !== monitor.name || existing.deletedAt)
      return store.update('monitoredResource', existing.id, { name: monitor.name, deletedAt: null });
    return existing;
  }
  return store.create('monitoredResource', {
    orgId: monitor.orgId,
    projectId: monitor.projectId,
    name: monitor.name,
    externalId: monitor.id,
    type: 'uptime',
    environment: 'production',
    status: monitor.status === 'unhealthy' ? 'unhealthy' : 'healthy',
    labels: {},
  });
}

/**
 * Run one monitor's check and store the outcome (one queue job = this). Creates the resource row when
 * missing. Returns { result, status } where status is the monitor's new state.
 */
export async function checkMonitorNow(store, monitor, { now = Date.now(), request, connect, resource } = {}) {
  const result = await runCheck(monitor, { request, connect });
  if (resource === undefined)
    resource = await store.find('monitoredResource', { orgId: monitor.orgId, externalId: monitor.id, type: 'uptime' });
  if (!resource || resource.deletedAt) resource = await ensureResource(store, monitor, resource);
  const status = await recordCheckResult(store, monitor, result, resource, now);
  return { result, status };
}

export class Gate {
  constructor(size) {
    this.size = size;
    this.active = 0;
    this.waiting = [];
  }
  async acquire() {
    if (this.active < this.size) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this.waiting.push(resolve));
  }
  release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}

/**
 * Check every due website with bounded concurrency. Hosts are spread out (round robin) and each host
 * gets at most `perHost` simultaneous checks, so one customer with many pages cannot hammer a site.
 * Returns how many checks ran. Stops starting new checks after `deadlineMs`.
 */
export async function runDueChecks(
  store,
  { now = Date.now(), concurrency = 40, perHost = 2, deadlineMs = 45000, request, connect, only } = {},
) {
  const where = { enabled: true, OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: new Date(now) } }] };
  if (only) where.id = only;
  const due = await store.client.uptimeMonitor.findMany({ where });
  if (!due.length) return 0;
  const resources = await store.client.monitoredResource.findMany({
    where: { type: 'uptime', externalId: { in: due.map((m) => m.id) } },
  });
  const resourceOf = new Map(resources.map((r) => [r.externalId, r]));
  // Round-robin by host so a single busy host does not occupy every worker slot.
  const byHost = new Map();
  for (const monitor of due) {
    const host = hostOf(monitor.target);
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(monitor);
  }
  const queue = [];
  for (let i = 0; queue.length < due.length; i++)
    for (const list of byHost.values()) if (list[i]) queue.push(list[i]);
  const gates = new Map([...byHost.keys()].map((h) => [h, new Gate(perHost)]));
  const deadline = Date.now() + deadlineMs;
  let ran = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length && Date.now() < deadline) {
      const monitor = queue[cursor++];
      const gate = gates.get(hostOf(monitor.target));
      await gate.acquire();
      try {
        const result = await runCheck(monitor, { request, connect });
        let resource = resourceOf.get(monitor.id);
        if (!resource || resource.deletedAt) resource = await ensureResource(store, monitor, resource);
        await recordCheckResult(store, monitor, result, resource, now);
        ran++;
      } catch (error) {
        console.error('Website check:', error.message);
      } finally {
        gate.release();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return ran;
}
