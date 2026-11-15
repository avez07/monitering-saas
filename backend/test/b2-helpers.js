import http from 'node:http';
import { resetTransports, setTransports } from '../src/services/contacts.js';

/** Create a server (agent + resource) in an organization, last seen at `lastSeen`. */
export async function makeServer(store, owner, name = 'srv-1', lastSeen = new Date()) {
  const agent = await store.create('agent', {
    orgId: owner.orgId,
    projectId: owner.project.id,
    name,
    platform: 'linux',
    version: '1.0.0',
    status: 'healthy',
    lastSeen,
  });
  const resource = await store.create('monitoredResource', {
    orgId: owner.orgId,
    projectId: owner.project.id,
    agentId: agent.id,
    name,
    type: 'server',
    environment: 'production',
    status: 'healthy',
    labels: {},
  });
  return { agent, resource };
}

/** Insert one sample every `step` ms from `from` to `to` (inclusive). */
export async function feed(store, server, from, to, values, step = 30000) {
  const rows = [];
  for (let t = from; t <= to; t += step)
    rows.push({
      time: new Date(t),
      agentId: server.agent.id,
      orgId: server.agent.orgId,
      cpuPercent: 10,
      memPercent: 20,
      diskPercent: 30,
      ...values,
    });
  await store.client.serverMetric.createMany({ data: rows, skipDuplicates: true });
}

/** Capture outgoing email/HTTP instead of sending it. */
export function captureTransports({ httpStatus = 200 } = {}) {
  const sent = { email: [], http: [] };
  setTransports({
    email: async (message) => {
      sent.email.push(message);
      return 'delivered';
    },
    http: async (request) => {
      sent.http.push(request);
      return { status: typeof httpStatus === 'function' ? httpStatus(request) : httpStatus, body: '{}' };
    },
  });
  return sent;
}
export { resetTransports };

/** A small local HTTP server. `handler(req, res)` decides each response. */
export async function fakeServer(handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, headers: req.headers });
    handler(req, res, hits);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    url: (path = '/') => `http://127.0.0.1:${server.address().port}${path}`,
    hits,
    close: () => new Promise((resolve) => (server.closeAllConnections?.(), server.close(resolve))),
  };
}
