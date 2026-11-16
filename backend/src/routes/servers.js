import { Router } from 'express';
import { z } from 'zod';
import { canAdmin, audit } from '../services/auth.js';
import { revokeAgentAccess } from '../services/agents.js';
import {
  RANGES,
  listServers,
  requireServer,
  serverDetail,
  serverMetrics,
  updateServer,
} from '../services/servers.js';

/** The Servers section: list, detail, charts, rename and settings. A server is identified by its agent id. */
export function serverRoutes(store) {
  const router = Router();

  router.get('/servers', async (req, res) => {
    const q = z.object({ includeDockerHosts: z.enum(['true', 'false']).optional() }).parse(req.query);
    res.json(await listServers(store, req.context.orgId, { includeDockerHosts: q.includeDockerHosts === 'true' }));
  });
  router.get('/servers/:id', async (req, res) => {
    const { agent, resource } = await requireServer(store, req.context.orgId, req.params.id);
    res.json(await serverDetail(store, agent, resource));
  });
  router.get('/servers/:id/metrics', async (req, res) => {
    const { range } = z
      .object({ range: z.enum(Object.keys(RANGES)).default('24h') })
      .parse(req.query);
    const { agent } = await requireServer(store, req.context.orgId, req.params.id);
    res.json(await serverMetrics(store, agent, range));
  });
  router.patch('/servers/:id', canAdmin, async (req, res) => {
    const input = z
      .object({ name: z.string().trim().min(1).max(100).optional(), config: z.unknown().optional() })
      .strict()
      .parse(req.body);
    const { agent, resource } = await requireServer(store, req.context.orgId, req.params.id);
    await updateServer(store, agent, resource, input);
    await audit(store, req.context, 'server.updated', resource.name, {
      fields: Object.keys(input),
    });
    const fresh = await requireServer(store, req.context.orgId, agent.id);
    res.json(await serverDetail(store, fresh.agent, fresh.resource));
  });
  router.delete('/servers/:id', canAdmin, async (req, res) => {
    const { agent, resource } = await requireServer(store, req.context.orgId, req.params.id);
    await store.update('monitoredResource', resource.id, { deletedAt: new Date().toISOString() });
    await revokeAgentAccess(store, agent);
    await audit(store, req.context, 'resource.deleted', resource.name);
    res.status(204).end();
  });
  return router;
}
