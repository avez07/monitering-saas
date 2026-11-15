// Turn the API's server fields into the app-wide status words.
const HIGH = 90;
const has = (v) => v !== null && v !== undefined;

/** Status key for StatusBadge: healthy | warning | unhealthy | unknown. */
export function serverStatus(server) {
  if (!server) return 'unknown';
  if (server.status === 'never_connected') return 'unknown';
  if (server.status === 'offline') return 'unhealthy';
  const high = [server.cpu, server.memory, server.disk].some((v) => has(v) && v >= HIGH);
  return high ? 'warning' : 'healthy';
}

export function statusLabel(server) {
  const key = serverStatus(server);
  if (key === 'unknown') return 'Waiting for data';
  if (key === 'unhealthy') return 'Down';
  return key === 'warning' ? 'Needs attention' : 'Healthy';
}

/** One plain sentence saying why a server needs attention (null when fine). */
export function serverReason(server) {
  if (server.status === 'never_connected')
    return 'Waiting for the first data. Check the connection steps.';
  if (server.status === 'offline') return 'Not reporting. Check that the agent is running.';
  if (has(server.disk) && server.disk >= HIGH) return `Disk is ${Math.round(server.disk)}% full.`;
  if (has(server.memory) && server.memory >= HIGH)
    return `Memory is ${Math.round(server.memory)}% used.`;
  if (has(server.cpu) && server.cpu >= HIGH) return `CPU is at ${Math.round(server.cpu)}%.`;
  return null;
}

/** Order for lists: problems first. */
const ORDER = { unhealthy: 0, warning: 1, unknown: 2, healthy: 3 };
export const bySeverity = (a, b) =>
  ORDER[serverStatus(a)] - ORDER[serverStatus(b)] || a.name.localeCompare(b.name);
