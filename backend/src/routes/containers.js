import { Router } from 'express';
import { z } from 'zod';
import { CONTAINER_RANGES, CONTAINER_STATES, containerDetail, containerMetrics, listContainers, requireContainer } from '../services/containers.js';

const id = z.string().max(80);

/** The Containers section. Read-only: containers are reported by the agent, never created or changed here. */
export function containerRoutes(store) {
  const router = Router();
  router.get('/containers', async (req, res) => {
    const q = z
      .object({
        serverId: id.optional(),
        state: z.enum([...CONTAINER_STATES, 'all']).optional(),
        q: z.string().max(100).optional(),
      })
      .parse(req.query);
    res.json(await listContainers(store, req.context.orgId, { serverId: q.serverId, state: q.state, search: q.q }));
  });
  router.get('/containers/:id', async (req, res) => {
    const { row, server } = await requireContainer(store, req.context.orgId, req.params.id);
    res.json(await containerDetail(store, row, server));
  });
  router.get('/containers/:id/metrics', async (req, res) => {
    const { range } = z.object({ range: z.enum(Object.keys(CONTAINER_RANGES)).default('1h') }).parse(req.query);
    const { row } = await requireContainer(store, req.context.orgId, req.params.id);
    res.json(await containerMetrics(store, row, range));
  });
  return router;
}
