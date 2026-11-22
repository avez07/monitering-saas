import { Router } from 'express';
import { z } from 'zod';
import { canEdit } from '../services/auth.js';
import {
  CONTAINER_RANGES,
  CONTAINER_STATES,
  LOG_LEVEL_NAMES,
  containerDetail,
  containerLogs,
  containerMetrics,
  listContainers,
  requireContainer,
  setContainerLogs,
} from '../services/containers.js';

const id = z.string().max(80);
const isoTime = z.string().max(40).optional();

/**
 * The Containers section. Containers are reported by the agent, never created here; the only setting is
 * whether the agent collects a container's logs.
 */
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
  // Container logs (docs/api/advanced-telemetry.md section 5): { items: [{time, stream, level, message}], nextSince }.
  router.get('/containers/:id/logs', async (req, res) => {
    const q = z
      .object({
        since: isoTime,
        until: isoTime,
        q: z.string().max(200).optional(),
        level: z.enum(LOG_LEVEL_NAMES).optional(),
        stream: z.enum(['stdout', 'stderr']).optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(200),
      })
      .parse(req.query);
    const { row } = await requireContainer(store, req.context.orgId, req.params.id);
    res.json(await containerLogs(store, row, q));
  });
  router.patch('/containers/:id/logs', canEdit, async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    const { row } = await requireContainer(store, req.context.orgId, req.params.id);
    res.json(await setContainerLogs(store, row, enabled));
  });
  return router;
}
