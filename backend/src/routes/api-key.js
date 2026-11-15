import { Router } from 'express';
import { z } from 'zod';
import { assert } from '../lib/errors.js';
import { canAdmin, audit } from '../services/auth.js';
import { activeApiKey, createApiKey } from '../services/api-keys.js';
import { revokeAllAgents } from '../services/agents.js';
import { agentSettingsSchema, newConfigId, ensureDefaultConfig } from '../services/agent-config.js';

const MAX_CONFIGS = 20;
const name = z.string().trim().min(1).max(80);

const describe = (key, servers = 0) => ({
  id: key.id,
  prefix: key.prefix,
  createdAt: key.createdAt,
  lastUsedAt: key.lastUsedAt,
  servers,
});

/** The one account API key, and the setup profiles agents pull. Admin-only, cookie-authenticated. */
export function apiKeyRoutes(store) {
  const router = Router();
  const guard = [canAdmin];

  router.get('/api-key', ...guard, async (req, res) => {
    const key = await activeApiKey(store, req.context.orgId);
    const servers = (await store.list('agent', { orgId: req.context.orgId })).filter(
      (a) => a.status !== 'revoked',
    ).length;
    res.json({ key: key ? describe(key, servers) : null });
  });
  // The raw key is returned only here (and on regenerate). It cannot be shown again.
  router.post('/api-key', ...guard, async (req, res) => {
    const { orgId, user } = req.context;
    assert(
      !(await activeApiKey(store, orgId)),
      409,
      'An API key already exists. Regenerate it if you need a new one.',
    );
    const { raw, row } = await createApiKey(store, orgId, user.id);
    await audit(store, req.context, 'api_key.created', row.prefix);
    res.status(201).json({ ...describe(row), key: raw });
  });
  router.post('/api-key/regenerate', ...guard, async (req, res) => {
    const { orgId, user } = req.context;
    const { raw, row } = await store.transaction(async (tx) => {
      await tx.updateMany('apiKey', { orgId, revokedAt: null }, { revokedAt: new Date() });
      return createApiKey(tx, orgId, user.id);
    });
    await audit(store, req.context, 'api_key.regenerated', row.prefix);
    res.status(201).json({ ...describe(row), key: raw });
  });
  // Revoking stops new installs. Servers already connected keep running unless told to disconnect.
  router.delete('/api-key', ...guard, async (req, res) => {
    const { disconnectServers } = z
      .object({ disconnectServers: z.enum(['true', 'false']).default('false') })
      .parse(req.query);
    const { orgId } = req.context;
    const key = await activeApiKey(store, orgId);
    assert(key, 404, 'There is no active API key.');
    await store.update('apiKey', key.id, { revokedAt: new Date() });
    const disconnected = disconnectServers === 'true' ? await revokeAllAgents(store, orgId) : 0;
    await audit(store, req.context, 'api_key.revoked', key.prefix, { disconnected });
    res.json({ revoked: true, disconnected });
  });

  router.get('/agent-configs', ...guard, async (req, res) => {
    await ensureDefaultConfig(store, req.context.orgId);
    res.json(await store.list('agentConfig', { orgId: req.context.orgId }));
  });
  router.post('/agent-configs', ...guard, async (req, res) => {
    const input = z.object({ name, settings: agentSettingsSchema.default({}) }).parse(req.body);
    const { orgId } = req.context;
    assert(
      (await store.list('agentConfig', { orgId })).length < MAX_CONFIGS,
      409,
      `You can keep up to ${MAX_CONFIGS} setup profiles.`,
    );
    const row = await store.create('agentConfig', { id: newConfigId(), orgId, ...input });
    await audit(store, req.context, 'agent_config.created', row.id);
    res.status(201).json(row);
  });
  router.put('/agent-configs/:id', ...guard, async (req, res) => {
    const input = z
      .object({ name: name.optional(), settings: agentSettingsSchema })
      .parse(req.body);
    const row = await store.find('agentConfig', { id: req.params.id, orgId: req.context.orgId });
    assert(row, 404, 'Setup profile not found.');
    // Agents compare versions, so every change bumps it.
    const updated = await store.update('agentConfig', row.id, {
      ...input,
      version: row.version + 1,
    });
    await audit(store, req.context, 'agent_config.updated', row.id);
    res.json(updated);
  });
  return router;
}
