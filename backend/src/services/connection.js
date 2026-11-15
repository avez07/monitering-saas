import {
  describeError,
  isProblem,
  AGENT_COMMANDS,
  NO_DATA_DIAGNOSIS,
} from './agent-errors.js';
import { configForAgent } from './agent-config.js';
import { onlineWindowMs, serverStatus } from './servers.js';

const SILENT_AFTER_MS = 2 * 60000;
const PENDING_SILENT_AFTER_MS = 3 * 60000;
const PROBLEM_WINDOW_MS = 3600000;
const REJECTION_CODES = new Set([
  'credential_revoked',
  'server_removed',
  'plan_limit',
  'rate_limited',
  'payload_too_large',
  'invalid_payload',
]);
const INSTALL_STARTED = new Set(['started', 'downloaded', 'verified', 'installed', 'service_started']);

export const enrich = (e) => ({
  id: e.id,
  at: e.createdAt,
  source: e.source,
  ...(({ title, explanation, severity, fix }) => ({ title, explanation, severity, fix }))(
    describeError(e.code, { message: e.message, details: e.details }),
  ),
  code: e.code,
  message: e.message,
  details: e.details,
});

const newestFirst = (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1);
const ago = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hour${h === 1 ? '' : 's'}` : `${Math.round(h / 24)} days`;
};

/** The latest event per problem code from the last hour, minus rejections that later data disproves. */
function activeProblems(events, lastDataAt, now) {
  const seen = new Set();
  const out = [];
  for (const e of [...events].sort(newestFirst)) {
    if (e.source === 'install' || !isProblem(e.code)) continue;
    if (now - e.createdAt.getTime() > PROBLEM_WINDOW_MS || seen.has(e.code)) continue;
    seen.add(e.code);
    if (describeError(e.code).severity === 'info') continue;
    if (REJECTION_CODES.has(e.code) && lastDataAt && lastDataAt > e.createdAt) continue;
    out.push(e);
  }
  return out;
}

/** The full connection report for one server. */
export async function connectionReport(store, agent, resource, now = Date.now()) {
  const settings = (await configForAgent(store, agent)).settings;
  const windowMs = onlineWindowMs(settings);
  const events = (
    await store.client.agentEvent.findMany({
      where: { agentId: agent.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    })
  ).sort(newestFirst);
  const lastMetric = await store.client.serverMetric.findFirst({
    where: { agentId: agent.id },
    orderBy: { time: 'desc' },
    select: { time: true },
  });
  const lastDataAt = lastMetric?.time ?? null;
  const contacted = agent.status !== 'pending';
  const lastContactMs = contacted ? now - new Date(agent.lastSeen).getTime() : null;
  const contactFresh = contacted && agent.status !== 'revoked' && lastContactMs <= windowMs;
  const dataMs = lastDataAt ? now - lastDataAt.getTime() : null;
  const dataFresh = dataMs !== null && dataMs <= windowMs && contactFresh;
  const problems = activeProblems(events, lastDataAt, now);
  const hasInstall = events.some((e) => e.source === 'install' && INSTALL_STARTED.has(e.code));
  const registeredAt = Math.max(
    agent.createdAt.getTime(),
    ...events.filter((e) => e.code === 'registered').map((e) => e.createdAt.getTime()),
  );
  // Rejections and agent-reported errors prove we can hear the server even when no data is accepted.
  const heardRecently = events.some(
    (e) => e.source !== 'install' && e.code !== 'first_data' && now - e.createdAt.getTime() < SILENT_AFTER_MS * 2.5,
  );
  const waitedLongEnough = now - registeredAt > SILENT_AFTER_MS;
  const silent = !dataFresh && !heardRecently && (contacted || waitedLongEnough);
  const overall = silent
    ? 'silent'
    : problems.length
      ? 'problem'
      : dataFresh
        ? 'connected'
        : heardRecently
          ? 'problem'
          : 'waiting';

  const state = (done, current, failed) => (done ? 'done' : failed ? 'failed' : current ? 'current' : 'waiting');
  const steps = [
    {
      key: 'install_started',
      title: 'Install started',
      state: 'done',
      detail: hasInstall ? 'The install script ran on your server.' : 'The server registered with your account.',
    },
    {
      key: 'registered',
      title: 'Agent installed and registered',
      state: 'done',
      detail: `Registered as ${agent.name}${agent.version ? ` (agent ${agent.version})` : ''}.`,
    },
    {
      key: 'running',
      title: 'Agent running',
      state: state(contactFresh, !silent, contacted || silent),
      detail: contactFresh
        ? `Heard from the agent ${ago(lastContactMs)} ago.`
        : contacted
          ? `We last heard from the agent ${ago(lastContactMs)} ago.`
          : silent
            ? "We haven't heard from the agent since it registered."
            : 'Waiting for the agent to start sending.',
    },
    {
      key: 'data',
      title: 'Data arriving',
      state: state(dataFresh, contactFresh, Boolean(lastDataAt) || silent),
      detail: lastDataAt
        ? `Last data ${ago(dataMs)} ago.`
        : 'No data received yet.',
      secondsAgo: dataMs === null ? null : Math.round(dataMs / 1000),
    },
    {
      key: 'problems',
      title: 'Problems reported',
      state: problems.length ? 'failed' : contacted || heardRecently ? 'done' : 'waiting',
      detail: problems.length
        ? `${problems.length} problem${problems.length === 1 ? '' : 's'} found. See the fixes below.`
        : contacted || heardRecently
          ? 'No problems reported.'
          : 'Nothing to report yet.',
    },
  ];

  return {
    server: {
      id: agent.id,
      name: resource.name,
      status: serverStatus(agent, settings, now),
    },
    overall,
    lastDataAt,
    lastDataSecondsAgo: dataMs === null ? null : Math.round(dataMs / 1000),
    steps,
    problems: problems.map(enrich),
    events: events.map(enrich),
    installTimeline: events
      .filter((e) => e.source === 'install')
      .reverse()
      .map(enrich),
    diagnosis: silent ? NO_DATA_DIAGNOSIS : null,
    commands: AGENT_COMMANDS,
  };
}

/** What the Add-server wizard can show before any server exists (events not yet attached to one). */
export async function pendingReport(store, orgId, since, now = Date.now()) {
  const horizon = new Date(now - 2 * 3600000);
  const events = (
    await store.client.agentEvent.findMany({
      where: { orgId, agentId: null, createdAt: { gt: horizon } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    })
  ).sort(newestFirst);
  const registered = await store.client.agent.findFirst({
    where: { orgId, createdAt: { gt: since && since > horizon ? since : horizon } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  const started = events.some((e) => INSTALL_STARTED.has(e.code));
  const failed = events.some((e) => e.code === 'failed');
  const first = events.length ? events[events.length - 1].createdAt.getTime() : since?.getTime();
  const silent = !registered && first !== undefined && now - first > PENDING_SILENT_AFTER_MS;
  const steps = [
    {
      key: 'install_started',
      title: 'Install started',
      state: registered || started ? 'done' : failed ? 'failed' : 'current',
      detail: started || registered ? 'The install script is running or finished.' : 'Waiting for you to run the install command.',
    },
    {
      key: 'registered',
      title: 'Agent installed and registered',
      state: registered ? 'done' : failed ? 'failed' : started ? 'current' : 'waiting',
      detail: registered ? 'A server registered with your account.' : 'Waiting for the server to register.',
    },
    { key: 'running', title: 'Agent running', state: 'waiting', detail: 'Starts after the install finishes.' },
    { key: 'data', title: 'Data arriving', state: 'waiting', detail: 'No data received yet.' },
    {
      key: 'problems',
      title: 'Problems reported',
      state: failed ? 'failed' : 'waiting',
      detail: failed ? 'The install reported a failure. See the fix below.' : 'Nothing to report yet.',
    },
  ];
  return {
    steps,
    events: events.map(enrich),
    serverId: registered?.id ?? null,
    diagnosis: silent ? NO_DATA_DIAGNOSIS : null,
  };
}
