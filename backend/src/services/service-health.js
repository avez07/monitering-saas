/**
 * Why is a service not healthy? Turns what the agent reported (state, detail) plus how fresh the
 * agent itself is into a structured answer: { code, message, since, hint, ... }.
 * `null` means healthy. See docs/api/errors.md for every code.
 */
export const AGENT_FRESH_MS = 150000;

const HINTS = {
  agent_offline:
    'The agent on this server has stopped reporting, so the real state is unknown. Run "docker ps" (or "systemctl status yuktiops-agent") on the server, then "yuktiops-agent doctor".',
  agent_auth_failed:
    'The agent’s credential was rejected. Register the server again with your API key: yuktiops-agent register --key=yk_live_...',
  service_failed: 'Read the unit’s log: journalctl -u <unit> -n 50 --no-pager, then restart it.',
  service_stopped: 'Start it (for example systemctl start <unit>) and check why it stopped: journalctl -u <unit> -n 50.',
  process_not_found: 'The process is not in the process list. Start it and check it is not crashing at startup.',
  connection_refused: 'Nothing is listening on that port. Start the service and check it binds to the address the agent uses (not only 127.0.0.1 if the agent is in a container).',
  connection_timeout: 'The port did not answer in time. Check a firewall, or that the service is not overloaded or hung.',
  dns_failed: 'The host name could not be resolved from the agent’s machine. Check the host name and DNS.',
  unhealthy_response: 'The service accepted the connection but did not answer correctly. Check its own log and health endpoint.',
  container_unhealthy: 'The container’s healthcheck is failing. Run: docker inspect --format "{{json .State.Health}}" <name>',
  container_exited: 'Run: docker logs --tail 50 <name>  and  docker inspect --format "{{.State.ExitCode}}" <name>',
  container_oom: 'The container ran out of memory. Raise its memory limit or find the leak.',
  unknown_state: 'The agent could not tell. Run "yuktiops-agent doctor" on the server.',
};

function classifyDetail(detail) {
  const d = (detail || '').toLowerCase();
  if (/refused/.test(d)) return 'connection_refused';
  if (/timed out|timeout/.test(d)) return 'connection_timeout';
  if (/dns|no such host|lookup/.test(d)) return 'dns_failed';
  if (/not found|no process|not running|inactive/.test(d)) return 'process_not_found';
  if (/unexpected|no answer|no greeting|status/.test(d)) return 'unhealthy_response';
  return null;
}

const MESSAGE = {
  agent_offline: 'The agent on this server is offline, so this service’s state is out of date.',
  service_failed: 'The service has failed.',
  service_stopped: 'The service is stopped.',
  process_not_found: 'The process is not running.',
  connection_refused: 'The service refused the connection.',
  connection_timeout: 'The service did not answer in time.',
  dns_failed: 'The service’s host name could not be resolved.',
  unhealthy_response: 'The service answered, but not correctly.',
  unknown_state: 'The service state is unknown.',
};

/** @returns {null | {code, message, cause, since, hint, service, severity}} */
export function serviceHealth(row, server, now = Date.now()) {
  const lastSeenAgent = server?.lastSeen ? new Date(server.lastSeen).getTime() : null;
  const since = (d) => (d ? new Date(d).toISOString() : null);
  const base = { service: row.name, timestamp: new Date(now).toISOString() };
  if (lastSeenAgent != null && now - lastSeenAgent > AGENT_FRESH_MS)
    return {
      ...base,
      code: 'agent_offline',
      message: MESSAGE.agent_offline,
      cause: `Last report from the agent was ${Math.round((now - lastSeenAgent) / 60000)} min ago.`,
      since: since(server.lastSeen),
      hint: HINTS.agent_offline,
      severity: 'warning',
    };
  if (row.state === 'running') return null;
  const code =
    classifyDetail(row.detail) ||
    (row.state === 'failed' ? 'service_failed' : row.state === 'stopped' ? 'service_stopped' : 'unknown_state');
  return {
    ...base,
    code,
    message: MESSAGE[code],
    cause: row.detail || null,
    since: since(row.stateChangedAt),
    hint: HINTS[code].replace(/<unit>/g, row.name),
    severity: row.state === 'unknown' ? 'warning' : 'critical',
  };
}
