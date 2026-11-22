import { z } from 'zod';
import { assert, HttpError } from '../lib/errors.js';
import { agentSettingsSchema, configForAgent } from './agent-config.js';
import { requireServer, saveAgentSettings } from './servers.js';

/** Services are things running on a host the agent watches. Websites, APIs and public ports live in Websites & APIs. */
export const SETUP_TYPES = ['tcp', 'nginx', 'apache', 'mysql', 'postgres', 'mssql', 'redis', 'systemd', 'process'];
const DEFAULT_STATUS_URL = { nginx: 'http://127.0.0.1/nginx_status', apache: 'http://127.0.0.1/server-status?auto' };
const DEFAULT_DB_PORT = { mysql: 3306, postgres: 5432, mssql: 1433, redis: 6379 };
/** Kinds that can use local credentials for deep metrics. Only the reference is stored; the secret stays on the host. */
const CREDENTIAL_KINDS = Object.keys(DEFAULT_DB_PORT);
const credentialsRef = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Use up to 40 lowercase letters, digits and dashes, starting with a letter or digit.');

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
    credentialsRef: credentialsRef.optional(),
  })
  .strict();

export const configServiceId = (agentId, kind, name) => `cfg.${agentId}.${kind}.${Buffer.from(name).toString('base64url')}`;
export function parseConfigServiceId(id) {
  const m = /^cfg\.([0-9a-f-]{36})\.([a-z]+)\.([A-Za-z0-9_-]+)$/.exec(id);
  return m ? { agentId: m[1], kind: m[2], name: Buffer.from(m[3], 'base64url').toString() } : null;
}

function agentEntry(input) {
  const { type, name } = input;
  assert(!input.credentialsRef || CREDENTIAL_KINDS.includes(type), 400, 'Credentials are only used for Redis, MySQL, PostgreSQL and SQL Server.');
  if (type === 'systemd') return { kind: 'systemd', name: input.unit ?? name };
  if (type === 'process') return { kind: 'process', name: input.processName ?? name };
  if (type === 'tcp') {
    assert(input.port, 400, 'Enter the port to check.');
    return { kind: 'port', name, port: input.port, ...(input.address ? { host: input.address } : {}) };
  }
  if (type === 'nginx' || type === 'apache') return { kind: type, name, url: input.url ?? DEFAULT_STATUS_URL[type] };
  // Databases: fall back to the standard port (the agent cannot dial port 0) and keep the host it should reach.
  return {
    kind: type,
    name,
    port: input.port ?? DEFAULT_DB_PORT[type],
    ...(input.address ? { host: input.address } : {}),
    ...(input.credentialsRef ? { credentialsRef: input.credentialsRef } : {}),
  };
}

/** Create a service: an entry in a host's agent config. */
export async function createService(store, orgId, input) {
  if (!input.host)
    throw new HttpError(400, input.type === 'tcp' ? 'Choose the host. For a public address use Websites & APIs.' : 'Choose the host this service runs on.');
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

/** Remove a service by id (reported service or pending config entry). Returns the removed name. */
export async function deleteService(store, orgId, id) {
  try {
    const parsed = parseConfigServiceId(id);
    if (parsed) {
      assert(await removeConfigEntry(store, orgId, parsed.agentId, parsed.kind, parsed.name), 404, 'Service not found.');
      return parsed.name;
    }
    assert(isUuid(id), 404, 'Service not found.');
    const item = await store.client.serviceItem.findFirst({ where: { id, orgId } });
    assert(item, 404, 'Service not found.');
    // Drop the config entry first so the agent stops reporting it, but a gone or broken host must not block removing the row.
    try {
      await removeConfigEntry(store, orgId, item.agentId, item.kind, item.name);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 404) console.error('service delete: config entry not removed:', error?.message);
    }
    await store.client.serviceItem.deleteMany({ where: { id: item.id } }); // idempotent: a concurrent delete is not an error
    return item.name;
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
    // null or "" removes the reference
    credentialsRef: z.union([credentialsRef, z.literal('')]).nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change.' });

const DB_FIELDS = ['port', 'address', 'credentialsRef'];
const ENTRY_FIELDS = {
  systemd: ['unit'],
  process: ['processName'],
  port: ['port', 'address'],
  nginx: ['url'],
  apache: ['url'],
  mysql: DB_FIELDS,
  postgres: DB_FIELDS,
  mssql: DB_FIELDS,
  redis: DB_FIELDS,
};
const ENTRY_TYPE = { port: 'tcp' };

function rejectFields(input, allowed, what) {
  const bad = Object.keys(input).filter((k) => !allowed.includes(k));
  assert(!bad.length, 400, `${bad.join(', ')} cannot be changed on ${what}.`);
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
  if (input.credentialsRef !== undefined) {
    if (input.credentialsRef) entry.credentialsRef = input.credentialsRef;
    else delete entry.credentialsRef;
  }
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

/** Edit an entry of a host's agent config in place (the id changes with the name). */
export async function updateService(store, orgId, id, input) {
  try {
    const parsed = parseConfigServiceId(id);
    if (parsed) return await updateConfigEntry(store, orgId, parsed.agentId, parsed.kind, parsed.name, input);
    assert(isUuid(id), 404, 'Service not found.');
    const item = await store.client.serviceItem.findFirst({ where: { id, orgId } });
    assert(item, 404, 'Service not found.');
    return await updateConfigEntry(store, orgId, item.agentId, item.kind, item.name, input);
  } catch (error) {
    throw failed('update', error);
  }
}
