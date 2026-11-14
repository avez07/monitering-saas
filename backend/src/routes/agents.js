import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { assert } from '../lib/errors.js';
import { token, digest } from '../lib/crypto.js';
import {
  canEdit,
  scopedRows,
  requireProject,
  requireRow,
  credentialAuth,
  audit,
} from '../services/auth.js';
import { enforceCount } from '../services/limits.js';

const text = z.string().min(1).max(100);
export function agentManagementRoutes(store) {
  const router = Router();
  router.get('/agents', async (req, res) =>
    res.json(await scopedRows(store, req.context, 'agent')),
  );
  router.post('/agents/enrollment-tokens', canEdit, async (req, res) => {
    const { projectId } = z.object({ projectId: text }).parse(req.body);
    await requireProject(store, req.context, projectId);
    const raw = token('enroll'),
      expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
    await store.create('agentEnrollmentToken', {
      orgId: req.context.orgId,
      projectId,
      tokenHash: digest(raw),
      expiresAt,
      usedAt: null,
    });
    await audit(store, req.context, 'enrollment_token.created', projectId);
    res.status(201).json({
      token: raw,
      expiresAt,
      command: `node backend/scripts/agent.mjs --enroll ${raw} --api ${config.API_PUBLIC_URL}`,
    });
  });
  router.post('/agents/:id/rotate', canEdit, async (req, res) => {
    const agent = await requireRow(store, req.context, 'agent', req.params.id);
    assert(agent.status !== 'revoked', 400, 'Enroll this agent again to restore access.');
    const raw = token('agent');
    await store.transaction(async (tx) => {
      for (const c of await tx.list('agentCredential', {
        orgId: req.context.orgId,
        agentId: agent.id,
      }))
        if (!c.revokedAt)
          await tx.update('agentCredential', c.id, { revokedAt: new Date().toISOString() });
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
    for (const c of await store.list('agentCredential', {
      orgId: req.context.orgId,
      agentId: agent.id,
    }))
      if (!c.revokedAt)
        await store.update('agentCredential', c.id, { revokedAt: new Date().toISOString() });
    await store.update('agent', agent.id, { status: 'revoked' });
    for (const r of await store.list('monitoredResource', { agentId: agent.id }))
      await store.update('monitoredResource', r.id, { status: 'unhealthy' });
    await audit(store, req.context, 'agent.revoked', agent.name);
    res.json({ message: 'Agent access revoked.' });
  });
  return router;
}
export function enrollmentRoute(store, limits) {
  return async (req, res) => {
    await limits.use(`enroll:${req.ip}`, 1, 20);
    const input = z
      .object({
        token: z.string().min(20).max(100),
        name: text,
        platform: text,
        version: text.default('0.1.0'),
      })
      .parse(req.body);
    const enrollment = await store.find('agentEnrollmentToken', { tokenHash: digest(input.token) });
    assert(
      enrollment && !enrollment.usedAt && new Date(enrollment.expiresAt) > new Date(),
      401,
      'Installation token is expired or already used.',
    );
    const raw = token('agent');
    const agent = await store.transaction(async (tx) => {
      const consumed = await tx.claim(
        'agentEnrollmentToken',
        enrollment.id,
        { usedAt: null },
        { usedAt: new Date().toISOString() },
      );
      assert(consumed, 401, 'Installation token is already used.');
      await enforceCount(
        tx,
        enrollment.orgId,
        'servers',
        (await tx.list('monitoredResource', { orgId: enrollment.orgId, type: 'server' })).filter(
          (r) => !r.deletedAt,
        ).length,
      );
      const agent = await tx.create('agent', {
        orgId: enrollment.orgId,
        projectId: enrollment.projectId,
        name: input.name,
        platform: input.platform,
        version: input.version,
        status: 'healthy',
        lastSeen: new Date().toISOString(),
      });
      await tx.create('agentCredential', {
        orgId: agent.orgId,
        projectId: agent.projectId,
        agentId: agent.id,
        kind: 'agent',
        name: agent.name,
        prefix: raw.slice(0, 14),
        tokenHash: digest(raw),
      });
      await tx.create('monitoredResource', {
        orgId: agent.orgId,
        projectId: agent.projectId,
        agentId: agent.id,
        name: input.name,
        type: 'server',
        environment: 'production',
        status: 'pending',
        labels: {},
      });
      return agent;
    });
    res.status(201).json({
      agentId: agent.id,
      token: raw,
      endpoint: config.API_PUBLIC_URL,
      heartbeatIntervalSeconds: 30,
    });
  };
}
export function heartbeatRoute(store, limits) {
  return [
    credentialAuth(store),
    async (req, res) => {
      const c = req.credential;
      assert(c.agentId, 403, 'Heartbeat requires an agent credential.');
      await limits.use(`heartbeat:${c.agentId}`, 1, 10);
      const input = z
        .object({
          cpu: z.number().min(0).max(100),
          memory: z.number().min(0).max(100),
          disk: z.number().min(0).max(100).optional(),
          cores: z.number().int().min(1).max(4096),
          ramGb: z.number().nonnegative(),
          uptimeSeconds: z.number().nonnegative(),
          environment: z
            .string()
            .regex(/^[a-z0-9-]{1,40}$/)
            .default('production'),
          os: z.string().max(100),
          networkRxBytes: z.number().nonnegative().optional(),
          networkTxBytes: z.number().nonnegative().optional(),
        })
        .parse(req.body);
      await store.update('agent', c.agentId, {
        status: 'healthy',
        lastSeen: new Date().toISOString(),
      });
      const resource = await store.find('monitoredResource', {
        agentId: c.agentId,
        type: 'server',
      });
      assert(resource, 404, 'Agent inventory record is missing.');
      await store.update('monitoredResource', resource.id, {
        status: input.cpu > 85 || input.memory > 90 ? 'warning' : 'healthy',
        environment: input.environment,
        labels: input,
      });
      res.json({ status: 'ok' });
    },
  ];
}
