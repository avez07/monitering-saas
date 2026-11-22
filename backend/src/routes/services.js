import { Router } from 'express';
import { z } from 'zod';
import { canAdmin, audit } from '../services/auth.js';
import { createServiceInput, createService, deleteService, updateServiceInput, updateService } from '../services/service-setup.js';
import { SERVICE_KINDS, SERVICE_STATES, listServices, serviceDetail } from '../services/services.js';

/** The Services section. Reads reported services; POST/PATCH/DELETE add, edit or remove what to watch. */
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
  router.post('/services', canAdmin, async (req, res) => {
    const created = await createService(store, req.context.orgId, createServiceInput.parse(req.body));
    await audit(store, req.context, 'service.created', created.name, { type: created.type, source: created.source });
    res.status(201).json(created);
  });
  router.patch('/services/:id', canAdmin, async (req, res) => {
    const input = updateServiceInput.parse(req.body);
    const updated = await updateService(store, req.context.orgId, req.params.id, input);
    await audit(store, req.context, 'service.updated', updated.name, { type: updated.type, source: updated.source, fields: Object.keys(input) });
    res.json(updated);
  });
  router.delete('/services/:id', canAdmin, async (req, res) => {
    const name = await deleteService(store, req.context.orgId, req.params.id);
    await audit(store, req.context, 'service.deleted', name);
    res.status(204).end();
  });
  return router;
}
