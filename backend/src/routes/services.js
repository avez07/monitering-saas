import { Router } from 'express';
import { z } from 'zod';
import { SERVICE_KINDS, SERVICE_STATES, listServices, serviceDetail } from '../services/services.js';

/** The Services section. Read-only: what to watch is chosen in the server's agent settings. */
export function serviceRoutes(store) {
  const router = Router();
  router.get('/services', async (req, res) => {
    const q = z
      .object({
        serverId: z.string().max(80).optional(),
        kind: z.enum(SERVICE_KINDS).optional(),
        state: z.enum(SERVICE_STATES).optional(),
        q: z.string().max(100).optional(),
      })
      .parse(req.query);
    res.json(await listServices(store, req.context.orgId, { serverId: q.serverId, kind: q.kind, state: q.state, search: q.q }));
  });
  router.get('/services/:id', async (req, res) => {
    res.json(await serviceDetail(store, req.context.orgId, req.params.id));
  });
  return router;
}
