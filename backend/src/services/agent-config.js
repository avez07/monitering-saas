import { randomBytes } from 'node:crypto';
import { z } from 'zod';

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
const serviceEntry = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('systemd'), name: serviceName }).strict(),
  z.object({ kind: z.literal('process'), name: serviceName }).strict(),
  z.object({ kind: z.literal('port'), name: serviceName, port: portNumber, host: hostName.optional() }).strict(),
  z.object({ kind: z.literal('nginx'), name: serviceName, url: statusUrl }).strict(),
  z.object({ kind: z.literal('apache'), name: serviceName, url: statusUrl }).strict(),
  ...['mysql', 'postgres', 'redis'].map((kind) =>
    z.object({ kind: z.literal(kind), name: serviceName, port: portNumber.optional(), host: hostName.optional() }).strict(),
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
