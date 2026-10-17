import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { assert } from '../lib/errors.js';
import { token, digest } from '../lib/crypto.js';
import {
  canEdit,
  canAdmin,
  scopedRows,
  requireProject,
  requireRow,
  credentialAuth,
  audit,
} from '../services/auth.js';
import { enforceCount, entitlements, meter } from '../services/limits.js';
import { forwardTelemetry, discoverServices } from '../services/telemetry.js';

const cleanCredential = ({ tokenHash, ...rest }) => rest;
const text = z.string().min(1).max(100);
export function collectorConfig(endpoint) {
  return `# Set PULSE_AGENT_TOKEN in the collector environment. Never commit it.\nreceivers:\n  otlp:\n    protocols:\n      http:\n        endpoint: 127.0.0.1:4318\n      grpc:\n        endpoint: 127.0.0.1:4317\n  hostmetrics:\n    collection_interval: 30s\n    scrapers:\n      cpu: {}\n      memory: {}\n      disk: {}\n      filesystem: {}\n      network: {}\n      load: {}\nprocessors:\n  memory_limiter:\n    check_interval: 1s\n    limit_mib: 128\n    spike_limit_mib: 32\n  attributes/redact:\n    actions:\n      - {key: http.request.header.authorization, action: delete}\n      - {key: http.request.header.cookie, action: delete}\n      - {key: db.statement, action: delete}\n      - {key: db.query.text, action: delete}\n      - {key: db.query.parameters, action: delete}\n  batch:\n    timeout: 5s\n    send_batch_size: 512\nexporters:\n  otlphttp/pulse:\n    endpoint: ${endpoint}/otlp\n    headers:\n      Authorization: Bearer \${env:PULSE_AGENT_TOKEN}\n    retry_on_failure:\n      enabled: true\n      initial_interval: 1s\n      max_interval: 30s\n      max_elapsed_time: 300s\n    sending_queue:\n      enabled: true\n      queue_size: 1000\n      storage: file_storage\nextensions:\n  file_storage:\n    directory: /var/lib/otelcol/queue\nservice:\n  extensions: [file_storage]\n  pipelines:\n    metrics:\n      receivers: [otlp, hostmetrics]\n      processors: [memory_limiter, attributes/redact, batch]\n      exporters: [otlphttp/pulse]\n    logs:\n      receivers: [otlp]\n      processors: [memory_limiter, attributes/redact, batch]\n      exporters: [otlphttp/pulse]\n    traces:\n      receivers: [otlp]\n      processors: [memory_limiter, attributes/redact, batch]\n      exporters: [otlphttp/pulse]\n`;
}
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
    res
      .status(201)
      .json({ token: raw, expiresAt, command: `node backend/scripts/agent.mjs --enroll ${raw}` });
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
      message: 'Save this token in AGENT_TOKEN in .env. It is shown only once.',
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
  router.get('/agents/:id/config', async (req, res) => {
    const agent = await requireRow(store, req.context, 'agent', req.params.id);
    const content = collectorConfig(config.API_PUBLIC_URL);
    res.type('text/yaml').send(content);
  });
  router.get('/keys', canAdmin, async (req, res) =>
    res.json(
      (await scopedRows(store, req.context, 'agentCredential', { kind: 'api' })).map(
        cleanCredential,
      ),
    ),
  );
  router.post('/keys', canAdmin, async (req, res) => {
    const input = z.object({ name: text, projectId: text }).parse(req.body);
    await requireProject(store, req.context, input.projectId);
    const raw = token('api');
    const row = await store.create('agentCredential', {
      ...input,
      orgId: req.context.orgId,
      tokenHash: digest(raw),
      prefix: raw.slice(0, 14),
      kind: 'api',
    });
    await audit(store, req.context, 'api_key.created', input.name);
    res.status(201).json({ ...cleanCredential(row), token: raw });
  });
  router.delete('/keys/:id', canAdmin, async (req, res) => {
    const row = await requireRow(store, req.context, 'agentCredential', req.params.id);
    await store.update('agentCredential', row.id, { revokedAt: new Date().toISOString() });
    res.status(204).end();
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
        demo: false,
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
      await tx.create('agentConfigVersion', {
        orgId: agent.orgId,
        agentId: agent.id,
        version: 1,
        content: collectorConfig(config.API_PUBLIC_URL),
      });
      return agent;
    });
    res.status(201).json({
      agentId: agent.id,
      token: raw,
      endpoint: `${config.API_PUBLIC_URL}/otlp`,
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
      res.json({ status: 'ok', configVersion: 1 });
    },
  ];
}
export function ingestRoute(store, limits) {
  return [
    credentialAuth(store),
    async (req, res) => {
      const kind = z.enum(['metrics', 'logs', 'traces']).parse(req.params.kind);
      const contentType = req.headers['content-type']?.split(';')[0];
      assert(
        ['application/json', 'application/x-protobuf'].includes(contentType),
        415,
        'Use OTLP/HTTP JSON or protobuf.',
      );
      assert(Buffer.isBuffer(req.body) && req.body.length, 400, 'An OTLP payload is required.');
      const c = req.credential;
      const { plan } = await entitlements(store, c.orgId);
      await limits.use(`ingest:${c.orgId}`, req.body.length, config.INGEST_BYTES_PER_MINUTE);
      let body = req.body,
        jsonPayload;
      if (contentType === 'application/json') {
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          assert(false, 400, 'Invalid JSON.');
        }
        const key = { metrics: 'resourceMetrics', logs: 'resourceLogs', traces: 'resourceSpans' }[
          kind
        ];
        assert(
          Array.isArray(payload[key]) && payload[key].length <= 100,
          400,
          `Expected an OTLP ${key} array with up to 100 resources.`,
        );
        const redact = (value) => {
          if (!value || typeof value !== 'object') return;
          for (const [key, child] of Object.entries(value)) {
            if (key === 'attributes' && Array.isArray(child)) {
              assert(child.length <= 128, 400, 'Too many telemetry attributes.');
              value[key] = child.filter(
                (a) => !/password|authorization|cookie|db\.(statement|query)/i.test(a.key),
              );
            } else redact(child);
          }
        };
        redact(payload);
        body = Buffer.from(JSON.stringify(payload));
        jsonPayload = payload;
      }
      await meter(store, c.orgId, kind, body.length, plan);
      if (config.DEMO_MODE) return res.json({ partialSuccess: {}, demo: true });
      const result = await forwardTelemetry(kind, c, body, contentType);
      if (jsonPayload) await discoverServices(store, c, jsonPayload, kind);
      res.type(result.contentType).send(result.body);
    },
  ];
}
