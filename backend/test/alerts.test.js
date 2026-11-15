import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAlerts, deliverNotifications } from '../src/services/workers.js';
import { registerMetricSource } from '../src/services/alert-metrics.js';
import { setup, closeStore, register, addMember } from './helpers.js';
import { makeServer, feed, captureTransports, resetTransports } from './b2-helpers.js';

let store, app, sent;
beforeEach(async () => {
  ({ store, app } = await setup());
  sent = captureTransports();
});
afterEach(resetTransports);
after(closeStore);

const T = Date.parse('2026-11-15T12:00:00Z');
const MIN = 60000;
const evaluate = (owner, now) => evaluateAlerts(store, owner.orgId, { now });
const incidents = (owner, filter = {}) => store.list('alertIncident', { orgId: owner.orgId, ...filter });
const ruleFromTemplate = async (owner, key, extra = {}) => {
  const res = await owner.client.post('/api/alerts/rules/from-template').send({ templateKey: key, ...extra });
  assert.equal(res.status, 201, res.text);
  return res.body;
};

test('new organizations get three active default rules; templates create valid rules', async () => {
  const owner = await register(app, 'Defaults');
  const rules = (await owner.client.get('/api/alerts/rules')).body;
  assert.deepEqual(
    rules.items.map((r) => r.templateKey).sort(),
    ['disk_almost_full', 'server_down', 'website_down'],
  );
  assert.ok(rules.items.every((r) => r.enabled && r.contacts === 'all'));
  const disk = rules.items.find((r) => r.templateKey === 'disk_almost_full');
  assert.equal(disk.summary, 'Alert me when disk space used is above 85% for 5 minutes on all servers.');

  const templates = (await owner.client.get('/api/alerts/templates')).body.items;
  assert.equal(templates.length, 10);
  assert.equal(templates.find((t) => t.key === 'disk_almost_full').alreadyCreated, true);
  assert.equal(templates.find((t) => t.key === 'container_stopped').available, false);
  // Every template produces a valid rule (the free plan allows 5 rules, so create paid-plan style by upgrading).
  const sub = await store.find('subscription', { orgId: owner.orgId });
  await store.update('subscription', sub.id, { planId: 'pro' });
  for (const t of templates) {
    const created = await ruleFromTemplate(owner, t.key, { name: `T ${t.key}` });
    assert.equal(created.metric, t.rule.metric);
    assert.equal(created.durationMinutes, t.rule.durationMinutes);
    assert.ok(created.summary.startsWith('Alert me when'), created.summary);
  }
  const cpu = (await owner.client.get('/api/alerts/rules')).body.items.find((r) => r.templateKey === 'cpu_very_high');
  assert.equal(cpu.threshold, 90);
  assert.equal(cpu.durationMinutes, 5);
});

test('rules are editable, plan-limited and role-protected', async () => {
  const owner = await register(app, 'Rules');
  const created = await ruleFromTemplate(owner, 'cpu_very_high');
  const edited = await owner.client
    .patch(`/api/alerts/rules/${created.id}`)
    .send({ threshold: 70, durationMinutes: 10, severity: 'critical' });
  assert.equal(edited.status, 200, edited.text);
  assert.equal(edited.body.summary, 'Alert me when CPU use is above 70% for 10 minutes on all servers.');
  // Free plan: 5 rules. 3 defaults + 1 = 4, one more fits, the next does not.
  await ruleFromTemplate(owner, 'memory_almost_full');
  const sixth = await owner.client.post('/api/alerts/rules/from-template').send({ templateKey: 'website_slow' });
  assert.equal(sixth.status, 402);
  const bad = await owner.client.post('/api/alerts/rules').send({ name: 'x1', metric: 'nope' });
  assert.equal(bad.status, 400);

  const viewer = await addMember(app, store, owner, { role: 'viewer' });
  assert.equal((await viewer.client.get('/api/alerts/rules')).status, 200);
  assert.equal(
    (await viewer.client.post('/api/alerts/rules/from-template').send({ templateKey: 'website_slow' })).status,
    403,
  );
  assert.equal((await viewer.client.patch(`/api/alerts/rules/${created.id}`).send({ enabled: false })).status, 403);
  assert.equal((await owner.client.delete(`/api/alerts/rules/${created.id}`)).status, 204);
  assert.equal((await owner.client.get('/api/alerts/rules')).body.items.some((r) => r.id === created.id), false);
});

test('a 4-minute spike does not fire a 5-minute rule, but 5 minutes does', async () => {
  const owner = await register(app, 'Spike');
  const srv = await makeServer(store, owner, 'web-1', new Date(T));
  await ruleFromTemplate(owner, 'cpu_very_high');
  await store.update('agent', srv.agent.id, { lastSeen: new Date(T) });
  // Quiet for the first minute, then 4 minutes of 95%.
  await feed(store, srv, T - 5 * MIN, T - 4 * MIN - 30000, { cpuPercent: 20 });
  await feed(store, srv, T - 4 * MIN, T, { cpuPercent: 95 });
  await evaluate(owner, T);
  assert.equal((await incidents(owner)).length, 0, '4 minutes is not 5 minutes');
  // Add the missing minute of high CPU: the window is now 5 minutes of breach.
  await feed(store, srv, T - 5 * MIN, T - 4 * MIN - 30000, { cpuPercent: 95 });
  await store.client.serverMetric.updateMany({
    where: { agentId: srv.agent.id, time: { lt: new Date(T - 4 * MIN) } },
    data: { cpuPercent: 95 },
  });
  await evaluate(owner, T);
  const [incident] = await incidents(owner);
  assert.equal(incident.state, 'firing');
  assert.equal(incident.name, 'CPU stays very high on web-1');
  // A window that is not fully covered by data yet (agent only just started) does not fire.
  const fresh = await makeServer(store, owner, 'new-box', new Date(T));
  await feed(store, fresh, T - 2 * MIN, T, { cpuPercent: 99 });
  await evaluate(owner, T);
  assert.equal((await incidents(owner)).length, 1);
});

test('fire, notify, recover with a recovery notification, and flap protection', async () => {
  const owner = await register(app, 'Recover');
  const srv = await makeServer(store, owner, 'db-1', new Date(T));
  await ruleFromTemplate(owner, 'cpu_very_high');
  await feed(store, srv, T - 5 * MIN, T, { cpuPercent: 95 });
  await evaluate(owner, T);
  await deliverNotifications(store, owner.orgId, { now: T });
  assert.equal(sent.email.length, 1);
  assert.match(sent.email[0].subject, /^\[WARNING\] CPU stays very high on db-1/);
  // Re-evaluating the same condition sends nothing more.
  await evaluate(owner, T);
  await deliverNotifications(store, owner.orgId, { now: T });
  assert.equal(sent.email.length, 1);

  // One quiet minute is not enough to close it, and a relapse cancels the recovery (flap protection).
  await store.update('agent', srv.agent.id, { lastSeen: new Date(T + 120000) });
  await feed(store, srv, T + 30000, T + 90000, { cpuPercent: 10 });
  await evaluate(owner, T + 90000); // clearing starts
  assert.equal((await incidents(owner))[0].state, 'firing');
  await feed(store, srv, T + 120000, T + 120000, { cpuPercent: 96 });
  await evaluate(owner, T + 120000); // relapse
  assert.equal((await incidents(owner))[0].clearSince, null);
  assert.equal((await incidents(owner)).length, 1);

  // Now it really recovers: the problem stays gone for a minute.
  await store.update('agent', srv.agent.id, { lastSeen: new Date(T + 300000) });
  await feed(store, srv, T + 150000, T + 300000, { cpuPercent: 10 });
  await evaluate(owner, T + 210000);
  assert.equal((await incidents(owner))[0].state, 'firing');
  await evaluate(owner, T + 300000);
  assert.equal((await incidents(owner))[0].state, 'resolved');
  await deliverNotifications(store, owner.orgId, { now: T + 300000 });
  assert.equal(sent.email.length, 2);
  assert.match(sent.email[1].subject, /^\[Recovered\] CPU stays very high on db-1/);
});

test('cooldown keeps a repeat quiet, then tells the user if it persists', async () => {
  const owner = await register(app, 'Cooldown');
  const srv = await makeServer(store, owner, 'app-1', new Date(T));
  await ruleFromTemplate(owner, 'cpu_very_high', { cooldownMinutes: 30 });
  const keepAlive = (t) => store.update('agent', srv.agent.id, { lastSeen: new Date(t) });
  await feed(store, srv, T - 5 * MIN, T, { cpuPercent: 95 });
  await evaluate(owner, T);
  // Recover.
  await keepAlive(T + 5 * MIN);
  await feed(store, srv, T + 30000, T + 5 * MIN, { cpuPercent: 10 });
  await evaluate(owner, T + 4 * MIN);
  await evaluate(owner, T + 5 * MIN);
  assert.equal((await incidents(owner, { state: 'resolved' })).length, 1);
  // Problem returns 6 minutes later: a new incident, but no new alert inside the 30 minute cooldown.
  const back = T + 12 * MIN;
  await keepAlive(back);
  await feed(store, srv, T + 5 * MIN + 30000, back, { cpuPercent: 95 });
  await evaluate(owner, back);
  const open = await incidents(owner, { state: 'firing' });
  assert.equal(open.length, 1);
  assert.equal(open[0].notified, false);
  await deliverNotifications(store, owner.orgId, { now: back });
  assert.equal(sent.email.length, 2, 'fired + recovered only');
  // Still broken after the cooldown has passed: now the user hears about it.
  const later = T + 32 * MIN;
  await keepAlive(later);
  await feed(store, srv, back + 30000, later, { cpuPercent: 95 });
  await evaluate(owner, later);
  await deliverNotifications(store, owner.orgId, { now: later });
  assert.equal(sent.email.length, 3);
});

test('a server that stops reporting alerts within 3 minutes, and recovery is announced', async () => {
  const owner = await register(app, 'Offline');
  const srv = await makeServer(store, owner, 'edge-1', new Date(T));
  await evaluate(owner, T + 60000);
  assert.equal((await incidents(owner)).length, 0);
  await evaluate(owner, T + 3 * MIN);
  const [incident] = await incidents(owner);
  assert.equal(incident.state, 'firing');
  assert.equal(incident.name, 'Server goes down on edge-1');
  assert.equal(incident.severity, 'critical');
  await deliverNotifications(store, owner.orgId, { now: T + 3 * MIN });
  assert.match(sent.email[0].subject, /^\[CRITICAL\] Server goes down/);
  assert.match(sent.email[0].text, /no data/);
  // It comes back.
  await store.update('agent', srv.agent.id, { lastSeen: new Date(T + 4 * MIN) });
  await evaluate(owner, T + 4 * MIN);
  await evaluate(owner, T + 5 * MIN + 1000);
  assert.equal((await incidents(owner))[0].state, 'resolved');
  await deliverNotifications(store, owner.orgId, { now: T + 6 * MIN });
  assert.match(sent.email[1].subject, /^\[Recovered\]/);
});

test('rules can target selected servers and selected contacts', async () => {
  const owner = await register(app, 'Routing');
  const a = await makeServer(store, owner, 'a-1', new Date(T));
  const b = await makeServer(store, owner, 'b-1', new Date(T));
  const second = await owner.client.post('/api/contacts').send({ type: 'email', name: 'On call', address: 'oncall@example.com' });
  assert.equal(second.status, 201, second.text);
  const rule = await ruleFromTemplate(owner, 'cpu_very_high', {
    scope: { type: 'selected', ids: [a.agent.id] },
    contactIds: [second.body.id],
  });
  assert.equal(rule.sendTo, 'Email');
  assert.equal(rule.summary, 'Alert me when CPU use is above 90% for 5 minutes on 1 selected server.');
  await feed(store, a, T - 5 * MIN, T, { cpuPercent: 99 });
  await feed(store, b, T - 5 * MIN, T, { cpuPercent: 99 });
  await evaluate(owner, T);
  const open = await incidents(owner, { ruleId: rule.id });
  assert.equal(open.length, 1);
  assert.equal(open[0].resourceId, a.resource.id);
  await deliverNotifications(store, owner.orgId, { now: T });
  assert.deepEqual(sent.email.map((m) => m.to), ['oncall@example.com']);
  const notFound = await owner.client.patch(`/api/alerts/rules/${rule.id}`).send({ scope: { type: 'selected', ids: ['nope'] } });
  assert.equal(notFound.status, 400);
});

test('incident history can be filtered, acknowledged and resolved; deleting a rule closes its alerts', async () => {
  const owner = await register(app, 'History');
  await makeServer(store, owner, 'old-1', new Date(T - 10 * MIN));
  await evaluate(owner, T);
  const list = await owner.client.get('/api/alerts/incidents?state=open');
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 1);
  const item = list.body.items[0];
  assert.equal(item.state, 'firing');
  assert.equal(item.resource.kind, 'server');
  assert.equal(item.ruleName, 'Server goes down');
  const ack = await owner.client.patch(`/api/alerts/incidents/${item.id}`).send({ state: 'acknowledged' });
  assert.equal(ack.body.state, 'acknowledged');
  assert.equal((await owner.client.get('/api/alerts/summary')).body.acknowledged, 1);
  const viewer = await addMember(app, store, owner, { role: 'viewer' });
  assert.equal((await viewer.client.patch(`/api/alerts/incidents/${item.id}`).send({ state: 'resolved' })).status, 403);
  // A disabled rule closes its alerts quietly on the next evaluation.
  const rules = (await owner.client.get('/api/alerts/rules')).body.items;
  await owner.client.patch(`/api/alerts/rules/${rules.find((r) => r.templateKey === 'server_down').id}`).send({ enabled: false });
  await evaluate(owner, T + MIN);
  const resolved = await owner.client.get('/api/alerts/incidents?state=resolved');
  assert.equal(resolved.body.items.length, 1);
  assert.equal(resolved.body.items[0].id, item.id);
  const again = await owner.client.patch(`/api/alerts/incidents/${item.id}`).send({ state: 'resolved' });
  assert.equal(again.status, 409);
});

test('later phases can plug new metric sources into the evaluator', async () => {
  const owner = await register(app, 'Plugin');
  await makeServer(store, owner, 'box-1', new Date(T));
  registerMetricSource('container_stopped', {
    label: 'Container stopped',
    kind: 'server',
    unit: '',
    defaults: { operator: 'gt', threshold: 0, durationMinutes: 0, severity: 'warning' },
    available: async () => true,
    format: (v) => `${v} stopped`,
    summary: () => 'Alert me when a container stops.',
    evaluate: async (ctx, rule, subject) => ({ fire: true, clear: false, value: 1, detail: `nginx stopped on ${subject.resource.name}` }),
  });
  try {
    await ruleFromTemplate(owner, 'container_stopped');
    await evaluate(owner, T);
    const inc = (await incidents(owner)).find((i) => i.name.startsWith('Container stopped'));
    assert.ok(inc);
    await deliverNotifications(store, owner.orgId, { now: T });
    assert.match(sent.email.at(-1).text, /nginx stopped on box-1/);
  } finally {
    registerMetricSource('container_stopped', {
      label: 'Container stopped',
      kind: 'server',
      unit: '',
      defaults: { operator: 'gt', threshold: 0, durationMinutes: 0, severity: 'warning' },
      available: async () => false,
      format: (v) => String(v),
      summary: (rule) => `Alert me when a container stops on ${rule.scopeType === 'selected' ? 'selected servers' : 'all servers'}.`,
      evaluate: async () => ({ fire: null, clear: null, value: null }),
    });
  }
});
