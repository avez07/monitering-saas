import { z } from 'zod';
import { assert, HttpError } from '../lib/errors.js';
import { enforceCount, entitlements } from './limits.js';
import { resolveTarget } from './uptime.js';
import { registrableDomain } from './rdap.js';
import { ensureResource, tcpTarget, hostOf } from './checks.js';
import { agentSettingsSchema, configForAgent } from './agent-config.js';
import { requireServer, saveAgentSettings } from './servers.js';
import { trySyncMonitor, tryRemoveMonitor } from '../queues/checks.js';

export const SETUP_TYPES = ['website', 'api', 'tcp', 'nginx', 'apache', 'mysql', 'postgres', 'redis', 'systemd', 'process'];
const DEFAULT_STATUS_URL = { nginx: 'http://127.0.0.1/nginx_status', apache: 'http://127.0.0.1/server-status?auto' };

export const createServiceInput = z
  .object({
    type: z.enum(SETUP_TYPES),
    name: z.string().trim().min(1).max(100),
    host: z.string().trim().min(1).max(80).optional(),
    port: z.coerce.number().int().min(1).max(65535).optional(),
    url: z.string().trim().url().max(2048).optional(),
    address: z.string().trim().min(1).max(253).optional(),
    unit: z.string().trim().min(1).max(100).optional(),
    processName: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export const configServiceId = (agentId, kind, name) => `cfg.${agentId}.${kind}.${Buffer.from(name).toString('base64url')}`;
export function parseConfigServiceId(id) {
  const m = /^cfg\.([0-9a-f-]{36})\.([a-z]+)\.([A-Za-z0-9_-]+)$/.exec(id);
  return m ? { agentId: m[1], kind: m[2], name: Buffer.from(m[3], 'base64url').toString() } : null;
}

async function createMonitor(store, orgId, input) {
  const { plan } = await entitlements(store, orgId);
  await enforceCount(store, orgId, 'monitors', (await store.list('uptimeMonitor', { orgId })).length);
  const project = (await store.list('project', { orgId })).filter((p) => !p.deletedAt).sort((a, b) => a.createdAt - b.createdAt)[0];
  assert(project, 400, 'This organization has no project yet.');
  const cols = { name: input.name, intervalSeconds: Math.max(300, plan.minCheckIntervalSeconds) };
  let type;
  if (input.type === 'tcp') {
    assert(input.address && input.port, 400, 'Enter the host and port to check.');
    type = 'tcp';
    cols.target = tcpTarget(input.address, input.port);
  } else {
    assert(input.url, 400, 'Enter the web address to check.');
    assert(/^https?:\/\//i.test(input.url), 400, 'Use an http:// or https:// address.');
    type = input.type === 'api' ? 'api' : 'http';
    cols.target = new URL(input.url).toString();
  }
  await resolveTarget(cols.target);
  cols.domain = type === 'tcp' ? null : registrableDomain(hostOf(cols.target));
  const monitor = await store.create('uptimeMonitor', {
    orgId,
    projectId: project.id,
    type,
    failureThreshold: 2,
    status: 'pending',
    consecutiveFailures: 0,
    enabled: true,
    nextCheckAt: new Date(),
    ...cols,
  });
  await ensureResource(store, monitor, null);
  return { monitor, type };
}

function agentEntry(input) {
  const { type, name } = input;
  if (type === 'systemd') return { kind: 'systemd', name: input.unit ?? name };
  if (type === 'process') return { kind: 'process', name: input.processName ?? name };
  if (type === 'tcp') {
    assert(input.port, 400, 'Enter the port to check.');
    return { kind: 'port', name, port: input.port, ...(input.address ? { host: input.address } : {}) };
  }
  if (type === 'nginx' || type === 'apache') return { kind: type, name, url: input.url ?? DEFAULT_STATUS_URL[type] };
  return { kind: type, name, ...(input.port ? { port: input.port } : {}) };
}

/** Create a service: an external monitor when it can be checked from outside, else an entry in a host's agent config. */
export async function createService(store, orgId, input) {
  const external = input.type === 'website' || input.type === 'api' || (input.type === 'tcp' && !input.host);
  if (external) {
    const { monitor, type } = await createMonitor(store, orgId, input);
    return { id: monitor.id, status: 'pending', source: 'monitor', type: input.type, kind: type, name: monitor.name, serverId: null, monitorId: monitor.id };
  }
  assert(input.host, 400, 'Choose the host this service runs on.');
  const { agent, resource } = await requireServer(store, orgId, input.host);
  const entry = agentEntry(input);
  const config = await configForAgent(store, agent);
  const settings = agentSettingsSchema.parse(config.settings);
  const services = settings.collectors.services;
  assert(
    !services.some((s) => s.kind === entry.kind && s.name.toLowerCase() === entry.name.toLowerCase()),
    409,
    'That service is already being monitored on this host.',
  );
  const next = agentSettingsSchema.parse({
    ...settings,
    hostKind: agent.kind || 'server',
    collectors: { ...settings.collectors, services: [...services, entry] },
  });
  await saveAgentSettings(store, agent, next, resource.name);
  return { id: configServiceId(agent.id, entry.kind, entry.name), status: 'pending', source: 'agent', type: input.type, kind: entry.kind, name: entry.name, serverId: agent.id, monitorId: null };
}

async function removeConfigEntry(store, orgId, agentId, kind, name) {
  const { agent, resource } = await requireServer(store, orgId, agentId);
  const config = await configForAgent(store, agent);
  const settings = agentSettingsSchema.parse(config.settings);
  const services = settings.collectors.services;
  const keep = services.filter((s) => !(s.kind === kind && s.name === name));
  if (keep.length === services.length) return false;
  await saveAgentSettings(
    store,
    agent,
    agentSettingsSchema.parse({ ...settings, hostKind: agent.kind || 'server', collectors: { ...settings.collectors, services: keep } }),
    resource.name,
  );
  return true;
}

const isUuid = (id) => /^[0-9a-f-]{36}$/.test(id);

/** Turn an unexpected failure into a described 500 (HttpError messages reach the client; raw errors never do). */
function failed(action, error) {
  if (error instanceof HttpError || error?.name === 'ZodError') return error;
  console.error(`service ${action} failed:`, error?.stack || error);
  const wrapped = new HttpError(500, `Could not ${action} this service. Try again; if it keeps failing, contact support.`);
  wrapped.cause = error;
  return wrapped;
}

/** Remove a service by id (reported service, pending config entry or monitor). Returns the removed name. */
export async function deleteService(store, orgId, id) {
  try {
    const parsed = parseConfigServiceId(id);
    if (parsed) {
      assert(await removeConfigEntry(store, orgId, parsed.agentId, parsed.kind, parsed.name), 404, 'Service not found.');
      return parsed.name;
    }
    assert(isUuid(id), 404, 'Service not found.');
    const item = await store.client.serviceItem.findFirst({ where: { id, orgId } });
    if (item) {
      // Drop the config entry first so the agent stops reporting it, but a gone or broken host must not block removing the row.
      try {
        await removeConfigEntry(store, orgId, item.agentId, item.kind, item.name);
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) console.error('service delete: config entry not removed:', error?.message);
      }
      await store.client.serviceItem.deleteMany({ where: { id: item.id } }); // idempotent: a concurrent delete is not an error
      return item.name;
    }
    const monitor = await store.find('uptimeMonitor', { id, orgId });
    assert(monitor, 404, 'Service not found.');
    // Keep the resource row (soft delete) so incident history still has a name to show.
    await store.updateMany('monitoredResource', { orgId, externalId: monitor.id }, { deletedAt: new Date() });
    await store.client.uptimeMonitor.deleteMany({ where: { id: monitor.id, orgId } }); // checks cascade
    await tryRemoveMonitor(monitor.id);
    return monitor.name;
  } catch (error) {
    throw failed('delete', error);
  }
}

export const updateServiceInput = z
  .object({
    name: createServiceInput.shape.name,
    host: createServiceInput.shape.host,
    port: createServiceInput.shape.port,
    url: createServiceInput.shape.url,
    address: createServiceInput.shape.address,
    unit: createServiceInput.shape.unit,
    processName: createServiceInput.shape.processName,
    intervalSeconds: z.coerce.number().int().min(1).max(86400),
    failureThreshold: z.coerce.number().int().min(1).max(10),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change.' });

const MONITOR_FIELDS = { http: ['url'], keyword: ['url'], api: ['url'], tcp: ['address', 'port'] };
const ENTRY_FIELDS = {
  systemd: ['unit'],
  process: ['processName'],
  port: ['port', 'address'],
  nginx: ['url'],
  apache: ['url'],
  mysql: ['port', 'address'],
  postgres: ['port', 'address'],
  redis: ['port', 'address'],
};
const ENTRY_TYPE = { port: 'tcp' };

function rejectFields(input, allowed, what) {
  const bad = Object.keys(input).filter((k) => !allowed.includes(k));
  assert(!bad.length, 400, `${bad.join(', ')} cannot be changed on ${what}.`);
}

async function updateMonitor(store, orgId, monitor, input) {
  rejectFields(input, ['name', 'intervalSeconds', 'failureThreshold', ...(MONITOR_FIELDS[monitor.type] ?? ['url'])], `a ${monitor.type} check`);
  const cols = {};
  if (input.name) cols.name = input.name;
  if (input.failureThreshold) cols.failureThreshold = input.failureThreshold;
  if (input.intervalSeconds) {
    const { plan } = await entitlements(store, orgId);
    assert(
      input.intervalSeconds >= plan.minCheckIntervalSeconds,
      402,
      `Your ${plan.name} plan checks at most every ${plan.minCheckIntervalSeconds} seconds.`,
    );
    cols.intervalSeconds = input.intervalSeconds;
  }
  if (monitor.type === 'tcp') {
    if (input.address || input.port) {
      const address = input.address ?? hostOf(monitor.target);
      const port = input.port ?? Number(new URL(monitor.target).port);
      assert(address && port, 400, 'Enter the host and port to check.');
      cols.target = tcpTarget(address, port);
    }
  } else if (input.url) {
    assert(/^https?:\/\//i.test(input.url), 400, 'Use an http:// or https:// address.');
    cols.target = new URL(input.url).toString();
  }
  if (cols.target) {
    await resolveTarget(cols.target);
    cols.domain = monitor.type === 'tcp' ? null : registrableDomain(hostOf(cols.target));
    if (cols.domain !== monitor.domain) Object.assign(cols, { domainExpiresAt: null, domainCheckedAt: null, domainStatus: null });
    cols.certificateExpiresAt = null;
  }
  const row = await store.update('uptimeMonitor', monitor.id, { ...cols, nextCheckAt: new Date() });
  await trySyncMonitor(row, { immediate: true });
  if (cols.name) await store.updateMany('monitoredResource', { orgId, externalId: monitor.id }, { name: cols.name });
  const type = row.type === 'tcp' ? 'tcp' : row.type === 'api' ? 'api' : 'website';
  return { id: row.id, status: row.status, source: 'monitor', type, kind: row.type, name: row.name, serverId: null, monitorId: row.id };
}

async function updateConfigEntry(store, orgId, agentId, kind, name, input) {
  rejectFields(input, ['host', 'name', ...(ENTRY_FIELDS[kind] ?? [])], `a ${kind} service`);
  const { agent, resource } = await requireServer(store, orgId, agentId);
  assert(!input.host || input.host === agent.id, 400, 'A service cannot be moved to another host. Add it there instead.');
  const config = await configForAgent(store, agent);
  const settings = agentSettingsSchema.parse(config.settings);
  const services = settings.collectors.services;
  const at = services.findIndex((s) => s.kind === kind && s.name === name);
  assert(at >= 0, 404, "Service not found in this host's configuration.");
  const entry = { ...services[at] };
  const newName = kind === 'systemd' ? (input.unit ?? input.name) : kind === 'process' ? (input.processName ?? input.name) : input.name;
  if (newName) entry.name = newName;
  if (input.port !== undefined) entry.port = input.port;
  if (input.url !== undefined) entry.url = input.url;
  if (input.address !== undefined) entry.host = input.address;
  assert(
    !services.some((s, i) => i !== at && s.kind === entry.kind && s.name.toLowerCase() === entry.name.toLowerCase()),
    409,
    'That service is already being monitored on this host.',
  );
  const next = agentSettingsSchema.parse({
    ...settings,
    hostKind: agent.kind || 'server',
    collectors: { ...settings.collectors, services: services.map((s, i) => (i === at ? entry : s)) },
  });
  await saveAgentSettings(store, agent, next, resource.name);
  return {
    id: configServiceId(agent.id, entry.kind, entry.name),
    status: 'pending',
    source: 'agent',
    type: ENTRY_TYPE[entry.kind] ?? entry.kind,
    kind: entry.kind,
    name: entry.name,
    serverId: agent.id,
    monitorId: null,
  };
}

/** Edit a service in place: a monitor's settings, or an entry of a host's agent config (the id changes with the name). */
export async function updateService(store, orgId, id, input) {
  try {
    const parsed = parseConfigServiceId(id);
    if (parsed) return await updateConfigEntry(store, orgId, parsed.agentId, parsed.kind, parsed.name, input);
    assert(isUuid(id), 404, 'Service not found.');
    const item = await store.client.serviceItem.findFirst({ where: { id, orgId } });
    if (item) return await updateConfigEntry(store, orgId, item.agentId, item.kind, item.name, input);
    const monitor = await store.find('uptimeMonitor', { id, orgId });
    assert(monitor, 404, 'Service not found.');
    return await updateMonitor(store, orgId, monitor, input);
  } catch (error) {
    throw failed('update', error);
  }
}
