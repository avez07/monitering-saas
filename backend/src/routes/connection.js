import { Router } from 'express';
import { z } from 'zod';
import { requireServer } from '../services/servers.js';
import { connectionReport, pendingReport } from '../services/connection.js';

export function connectionRoutes(store) {
  const router = Router();
  router.get('/servers/:id/connection', async (req, res) => {
    const { agent, resource } = await requireServer(store, req.context.orgId, req.params.id);
    res.json(await connectionReport(store, agent, resource));
  });
  router.get('/connection/pending', async (req, res) => {
    const { since } = z
      .object({ since: z.string().datetime().optional() })
      .parse(req.query);
    res.json(await pendingReport(store, req.context.orgId, since ? new Date(since) : undefined));
  });
  return router;
}
