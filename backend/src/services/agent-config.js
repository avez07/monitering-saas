import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { forgetOrgFeatures, orgHasFeature } from './limits.js';
import { CHANNELS, getRedis } from '../lib/redis.js';

const flag = z.boolean().default(true);

/** What an agent may be asked to watch (Phase 12). Only names, ports and local status URLs; never credentials. */
const hostName = z.string().max(253).regex(/^[A-Za-z0-9._:-]+$/, 'Use a host name or IP address.');
const serviceName = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9 @._:/+-]+$/, 'Use letters, digits and . _ - @ : / +');
const statusUrl = z
  .string()
  .max(300)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'Use an http or https URL.');
const portNumber = z.number().int().min(1).max(65535);
/** Names a secret the agent reads locally (env or credentials.d/<ref>.env). The secret itself never reaches us. */
export const credentialsRef = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Use 1-40 lowercase letters, digits or -, starting with a letter or digit.');
const containerName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/, 'Use a Docker container name.');
/** Where remote_write goes, relative to the agent's API base URL. Always set by the server. */
export const PROM_WRITE_PATH = '/v1/prom/write';
const serviceEntry = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('systemd'), name: serviceName }).strict(),
  z.object({ kind: z.literal('process'), name: serviceName }).strict(),
  z.object({ kind: z.literal('port'), name: serviceName, port: portNumber, host: hostName.optional() }).strict(),
  z.object({ kind: z.literal('nginx'), name: serviceName, url: statusUrl }).strict(),
  z.object({ kind: z.literal('apache'), name: serviceName, url: statusUrl }).strict(),
  ...['mysql', 'postgres', 'redis', 'mssql'].map((kind) =>
    z
      .object({
        kind: z.literal(kind),
        name: serviceName,
        port: portNumber.optional(),
        host: hostName.optional(),
        credentialsRef: credentialsRef.optional(),
      })
      .strict(),
  ),
]);
/**
 * What a setup profile may contain. Remote settings can only switch built-in, read-only collectors
 * on or off and change reporting intervals. The agent never executes anything it is sent.
 */
export const agentSettingsSchema = z
  .object({
    sendIntervalSeconds: z.number().int().min(15).max(300).default(30),
    sampleIntervalSeconds: z.number().int().min(5).max(60).default(10),
    hostKind: z.enum(['server', 'docker-host']).default('server'),
    collectors: z
      .object({
        cpu: flag,
        memory: flag,
        swap: flag,
        disk: flag,
        diskIo: flag,
        network: flag,
        load: flag,
        processes: flag,
        docker: z.boolean().default(false),
        services: z
          .array(serviceEntry)
          .max(50)
          .default([])
          .refine((list) => new Set(list.map((s) => `${s.kind}:${s.name.toLowerCase()}`)).size === list.length, {
            message: 'Each service kind and name may be listed only once.',
          }),
        // Prometheus remote_write (premium). Set by the server from plan.features.promMetrics; users cannot change it.
        prometheus: z.boolean().default(false),
        // Docker container logs over OTLP (all plans, counted against the telemetry quota).
        containerLogs: z
          .object({
            enabled: z.boolean().default(false),
            include: z.array(containerName).max(200).default([]), // empty = every running container
            exclude: z.array(containerName).max(200).default([]),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    prometheus: z
      .object({
        path: z.string().max(100).regex(/^\/[A-Za-z0-9/_.-]*$/).default(PROM_WRITE_PATH),
        scrapeIntervalSeconds: z.number().int().min(15).max(60).default(15),
      })
      .strict()
      .default({}),
  })
  .strict()
  .refine((s) => s.sampleIntervalSeconds <= s.sendIntervalSeconds, {
    message: 'sampleIntervalSeconds cannot be longer than sendIntervalSeconds.',
    path: ['sampleIntervalSeconds'],
  });

export const defaultSettings = () => agentSettingsSchema.parse({});
export const newConfigId = () => `st_${randomBytes(12).toString('hex')}`;
export const CONFIG_ID = /^st_[a-f0-9]{24}$/;

/** The organization's default setup profile, created on first use if it does not exist yet. */
export async function ensureDefaultConfig(store, orgId) {
  const existing = await store.find('agentConfig', { orgId, isDefault: true });
  if (existing) return existing;
  try {
    return await store.create('agentConfig', {
      id: newConfigId(),
      orgId,
      name: 'Default',
      isDefault: true,
      version: 1,
      settings: defaultSettings(),
    });
  } catch (error) {
    if (error.code !== 'P2002') throw error; // another request created it first
    return store.find('agentConfig', { orgId, isDefault: true });
  }
}

/** The profile a given agent should follow: its own, or the organization default. */
export async function configForAgent(store, agent) {
  if (agent.configId) {
    const own = await store.find('agentConfig', { id: agent.configId, orgId: agent.orgId });
    if (own) return own;
  }
  return ensureDefaultConfig(store, agent.orgId);
}

/**
 * Overwrite what only the server decides: the Prometheus collector follows the plan and always writes to
 * our endpoint. Applied whenever settings are saved or served, so a user cannot switch it on themselves.
 */
export function withPlanSettings(settings, promEnabled) {
  return {
    ...settings,
    collectors: { ...settings.collectors, prometheus: Boolean(promEnabled) },
    prometheus: { ...settings.prometheus, path: PROM_WRITE_PATH },
  };
}
/** `withPlanSettings` for an organization's current plan. */
export async function enforcePlanSettings(store, orgId, settings) {
  return withPlanSettings(settings, await orgHasFeature(store, orgId, 'promMetrics'));
}
/** A setup profile as an agent should see it (stored settings plus the plan-controlled fields). */
export async function servedSettings(store, setup) {
  let settings;
  try {
    settings = agentSettingsSchema.parse(setup.settings ?? {});
  } catch {
    return setup.settings; // an unreadable stored profile is served as it is (the agent validates too)
  }
  return enforcePlanSettings(store, setup.orgId, settings);
}

/**
 * The plan changed (billing, downgrade, dunning, platform admin). Every setup profile of the organization
 * gets `collectors.prometheus = plan.features.promMetrics`; changed profiles get a new version, so agents
 * re-pull their settings on the next ingest reply and start or stop the collector without a restart.
 * Returns `{ enabled, changed }`.
 */
export async function onPlanChanged(store, orgId) {
  await forgetOrgFeatures(orgId).catch((error) => console.error('agent-config: feature cache:', error.message));
  const enabled = await orgHasFeature(store, orgId, 'promMetrics');
  await ensureDefaultConfig(store, orgId);
  let changed = 0;
  for (const row of await store.list('agentConfig', { orgId })) {
    let settings;
    try {
      settings = agentSettingsSchema.parse(row.settings ?? {});
    } catch (error) {
      console.error(`agent-config: profile ${row.id} is unreadable, plan change skipped:`, error.message);
      continue;
    }
    const next = withPlanSettings(settings, enabled);
    if (
      row.settings?.collectors?.prometheus === next.collectors.prometheus &&
      row.settings?.prometheus?.path === next.prometheus.path
    )
      continue;
    await store.update('agentConfig', row.id, { settings: next, version: row.version + 1 });
    changed++;
  }
  // The store already bumps the cache epoch on each write; this also makes other instances drop entries now.
  if (changed)
    await getRedis()
      .publish(CHANNELS.agentInvalidate, '*')
      .catch((error) => console.error('agent-config: invalidate publish failed:', error.message));
  return { enabled, changed };
}
