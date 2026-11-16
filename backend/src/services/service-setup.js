import { z } from 'zod';
import { assert } from '../lib/errors.js';
import { enforceCount, entitlements } from './limits.js';
import { resolveTarget } from './uptime.js';
import { registrableDomain } from './rdap.js';
import { ensureResource, tcpTarget, hostOf } from './checks.js';
import { agentSettingsSchema, configForAgent } from './agent-config.js';
import { requireServer, saveAgentSettings } from './servers.js';

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

/** Remove a service by id (reported service, pending config entry or monitor). Returns the removed name. */
export async function deleteService(store, orgId, id) {
  const parsed = parseConfigServiceId(id);
  if (parsed) {
    assert(await removeConfigEntry(store, orgId, parsed.agentId, parsed.kind, parsed.name), 404, 'Service not found.');
    return parsed.name;
  }
  assert(/^[0-9a-f-]{36}$/.test(id), 404, 'Service not found.');
  const item = await store.client.serviceItem.findFirst({ where: { id, orgId } });
  if (item) {
    await removeConfigEntry(store, orgId, item.agentId, item.kind, item.name);
    await store.client.serviceItem.delete({ where: { id: item.id } });
    return item.name;
  }
  const monitor = await store.find('uptimeMonitor', { id, orgId });
  assert(monitor, 404, 'Service not found.');
  await store.updateMany('monitoredResource', { orgId, externalId: monitor.id }, { deletedAt: new Date() });
  await store.remove('uptimeMonitor', monitor.id);
  return monitor.name;
}
