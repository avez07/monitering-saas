import { Router } from 'express';
import { assert } from '../lib/errors.js';
import { token, digest } from '../lib/crypto.js';
import { canEdit, scopedRows, requireRow, audit } from '../services/auth.js';
import { revokeAgentAccess } from '../services/agents.js';

/**
 * Managing servers that already exist. New servers are never created here: they appear when the agent
 * registers with the account API key (routes/v1.js).
 */
export function agentManagementRoutes(store) {
  const router = Router();
  router.get('/agents', async (req, res) =>
    res.json(await scopedRows(store, req.context, 'agent')),
  );
  router.post('/agents/:id/rotate', canEdit, async (req, res) => {
    const agent = await requireRow(store, req.context, 'agent', req.params.id);
    assert(
      agent.status !== 'revoked',
      400,
      'Reinstall the agent on this server to restore access.',
    );
    const raw = token('agent');
    await store.transaction(async (tx) => {
      await tx.updateMany(
        'agentCredential',
        { orgId: req.context.orgId, agentId: agent.id, revokedAt: null },
        { revokedAt: new Date() },
      );
      await tx.create('agentCredential', {
        orgId: agent.orgId,
        projectId: agent.projectId,
        agentId: agent.id,
        name: agent.name,
        kind: 'agent',
        tokenHash: digest(raw),
        prefix: raw.slice(0, 14),
      });
    });
    await audit(store, req.context, 'agent.credential_rotated', agent.name);
    res.json({
      token: raw,
      message:
        'Save this token in the agent configuration and restart the agent. It is shown only once.',
    });
  });
  router.post('/agents/:id/revoke', canEdit, async (req, res) => {
    const agent = await requireRow(store, req.context, 'agent', req.params.id);
    await revokeAgentAccess(store, agent);
    await audit(store, req.context, 'agent.revoked', agent.name);
    res.json({ message: 'Server access revoked.' });
  });
  return router;
}
