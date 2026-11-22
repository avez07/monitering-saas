/** Plain-language catalog of everything that can go wrong between a server and YuktiOps. */

const API_HOST = 'api.yuktiops.com';
const restart = 'sudo systemctl restart yuktiops-agent';
const logs = 'sudo journalctl -u yuktiops-agent -n 50 --no-pager';

const entry = (severity, title, explanation, summary, commands = []) => ({
  severity,
  title,
  explanation,
  fix: { summary, commands },
});

const network = (title, explanation) =>
  entry('error', title, explanation, `Allow outbound HTTPS (port 443) to ${API_HOST}, then check it.`, [
    `curl -I https://${API_HOST}/api/health`,
    'sudo yuktiops-agent doctor',
  ]);

export const CATALOG = {
  https_unreachable: network(
    "Your server can't reach YuktiOps over HTTPS",
    `The agent could not open a connection to ${API_HOST} on port 443. If you use a firewall or security group, allow outbound HTTPS to ${API_HOST}.`,
  ),
  dns_failed: entry(
    'error',
    "Your server can't look up our address (DNS)",
    `The name ${API_HOST} did not resolve to an address from this server, so the agent cannot connect.`,
    'Check that this server has a working DNS resolver.',
    [`getent hosts ${API_HOST}`, 'cat /etc/resolv.conf', 'sudo yuktiops-agent doctor'],
  ),
  tls_failed: entry(
    'error',
    'The secure connection could not be set up (TLS)',
    "The HTTPS handshake failed. This is usually a wrong system clock, missing CA certificates, or a proxy that re-signs traffic.",
    'Update the CA certificates and make sure the clock is right.',
    ['sudo timedatectl set-ntp true', 'sudo update-ca-certificates', `curl -vI https://${API_HOST}/api/health`],
  ),
  proxy_error: entry(
    'error',
    "The agent can't get through your proxy",
    'The agent tried to use an HTTP(S) proxy configured on this server and the proxy refused or did not answer.',
    'Check the proxy address in the agent environment, or allow the agent through it.',
    [
      'sudo systemctl show yuktiops-agent -p Environment',
      `curl -I -x "$HTTPS_PROXY" https://${API_HOST}/api/health`,
      'sudo yuktiops-agent doctor',
    ],
  ),
  clock_skew: entry(
    'warning',
    "Your server's clock is wrong",
    "The server's clock differs from real time by more than two minutes. We correct the timestamps so no data is lost, but charts and alerts are safer with a correct clock.",
    'Turn on automatic time sync.',
    ['sudo timedatectl set-ntp true', 'timedatectl status'],
  ),
  credential_revoked: entry(
    'error',
    'This server was disconnected from your account',
    'The server\'s credential was revoked (for example the server was removed, or all servers were disconnected when the API key was revoked), so we reject its data.',
    'Reconnect it by running the install command from your dashboard again (Servers, Add server).',
    ['sudo yuktiops-agent doctor'],
  ),
  server_removed: entry(
    'error',
    'This server was removed from your account',
    'The server was deleted in the dashboard, so new data is refused.',
    'To monitor it again, run the install command from your dashboard on this server.',
  ),
  plan_limit: entry(
    'error',
    "You've reached your plan's server limit",
    'Your plan allows a fixed number of servers (the Free plan allows 2). This server could not be added.',
    'Upgrade your plan or remove a server you no longer need, then restart the agent.',
    [restart],
  ),
  rate_limited: entry(
    'warning',
    'The agent is sending too often',
    'We accepted fewer requests than the agent tried to send, and asked it to slow down. It retries automatically.',
    'Raise the send interval in the server settings (at least 15 seconds), or make sure only one agent runs on this server.',
    ['pgrep -a yuktiops'],
  ),
  payload_too_large: entry(
    'warning',
    'A batch of data was too large',
    'The agent sent more data at once than we accept (often after a long outage when many samples were buffered).',
    'It usually clears itself as the agent sends smaller batches. If it repeats, update the agent.',
    ['yuktiops-agent version', logs],
  ),
  payload_rejected: entry(
    'warning',
    'Some data was rejected as invalid',
    'We refused a batch because values were out of range or in the wrong format.',
    'Update the agent to the latest version.',
    ['yuktiops-agent version', logs],
  ),
  invalid_payload: entry(
    'warning',
    'Some data was rejected as invalid',
    'We refused a batch because values were out of range or in the wrong format.',
    'Update the agent to the latest version.',
    ['yuktiops-agent version', logs],
  ),
  docker_socket_denied: entry(
    'warning',
    "The agent isn't allowed to read Docker",
    'Container monitoring is on, but the agent user cannot open the Docker socket (/var/run/docker.sock).',
    'Add the agent user to the docker group and restart the agent, or turn container monitoring off in the server settings. If the agent runs in a Docker container, start it with --group-add 0 (Docker Desktop on Windows or Mac) or --group-add $(stat -c "%g" /var/run/docker.sock) (Linux) next to the docker.sock mount.',
    ['sudo usermod -aG docker yuktiops', restart],
  ),
  disk_permission: entry(
    'warning',
    "The agent isn't allowed to read some disks",
    'The agent could not read usage of a mounted disk because of file permissions, so that disk is missing from your charts.',
    'Check the permissions of the mount point and the agent logs.',
    ['df -h', logs],
  ),
  processes_restricted: entry(
    'info',
    'Some processes are hidden from the agent',
    'The operating system hides other users\' processes from the agent (for example hidepid on /proc), so the top-processes list may be incomplete.',
    'Nothing is broken. To see every process, mount /proc without hidepid or turn the processes collector off.',
    ['mount | grep proc'],
  ),
  config_invalid: entry(
    'warning',
    'The agent settings are invalid',
    'The local configuration file or the settings pulled from your dashboard could not be used, so safe defaults are in use.',
    'Check the config file for typos, or re-apply the settings in the dashboard.',
    ['sudo yuktiops-agent doctor', 'sudo cat /etc/yuktiops/agent.yaml'],
  ),
  config_pull_failed: entry(
    'warning',
    'The agent could not fetch its settings',
    'It keeps using its last settings. Usually a short network problem.',
    'If it persists, check that this server can reach us over HTTPS.',
    [`curl -I https://${API_HOST}/api/health`],
  ),
  config_adjusted: entry(
    'info',
    'Some settings were adjusted',
    'A setting was outside the allowed range, so the agent used the nearest allowed value.',
    'Review the settings for this server.',
  ),
  buffer_full: entry(
    'warning',
    'The agent ran out of room to hold data while offline',
    'It could not reach us for a long time and its local buffer filled up, so the oldest samples were dropped.',
    'Fix the connection first. Free disk space if this server is almost full.',
    ['df -h /var/lib/yuktiops', 'sudo yuktiops-agent doctor'],
  ),
  buffer_write_failed: entry(
    'warning',
    "The agent can't save data on disk while offline",
    'It could not write its local buffer (disk full or no permission), so data may be lost during outages.',
    'Free up disk space and check the permissions of the data directory.',
    ['df -h', 'ls -ld /var/lib/yuktiops'],
  ),
  send_failed: entry(
    'error',
    'The agent could not send data',
    'A request to YuktiOps failed. The agent keeps the data and retries.',
    'Check the connection from this server.',
    [`curl -I https://${API_HOST}/api/health`, 'sudo yuktiops-agent doctor'],
  ),
  server_error: entry(
    'warning',
    'YuktiOps had a problem',
    'Our server answered with an error. The agent keeps the data and retries, so nothing is lost.',
    'No action needed. If it lasts more than a few minutes, check our status page.',
  ),
  agent_error: entry(
    'warning',
    'The agent reported a problem',
    'The agent hit an unexpected problem. The message below says what.',
    'Look at the agent log.',
    [logs],
  ),
  unknown: entry(
    'warning',
    'The agent reported something we do not recognise',
    'This looks like a problem from a newer or older agent. The original message is shown below.',
    'Update the agent and check its log.',
    ['yuktiops-agent version', logs],
  ),
  // Install steps (informational).
  started: entry('info', 'Install started', 'The install script began running on your server.', ''),
  downloaded: entry('info', 'Agent downloaded', 'The agent file was downloaded.', ''),
  verified: entry('info', 'Download verified', 'The download matched its checksum.', ''),
  installed: entry('info', 'Agent installed', 'The agent program was put in place.', ''),
  registered: entry('info', 'Server registered', 'The server was added to your account.', ''),
  service_started: entry('info', 'Agent started', 'The background service was started.', ''),
  first_data: entry('info', 'First data received', 'The first measurements arrived.', ''),
  failed: entry(
    'error',
    'The install failed',
    'The install script stopped with an error. The message below says where.',
    'Run the doctor, then run the install command again.',
    ['sudo yuktiops-agent doctor'],
  ),
};

/** Codes that are progress, not problems. */
export const INFO_CODES = new Set(
  Object.entries(CATALOG)
    .filter(([, v]) => v.severity === 'info')
    .map(([k]) => k),
);

/** Look up a code; `collector_failed_x` and anything unknown fall back gracefully. */
export function describeError(code, { message = '', details = {} } = {}) {
  let found = CATALOG[code];
  if (!found && /^collector_failed_/.test(code)) {
    const what = code.slice('collector_failed_'.length);
    found = entry(
      'warning',
      `The "${what}" measurement is failing`,
      `The agent could not collect ${what} data, so that chart may be empty.`,
      'Check the agent log for the reason, and update the agent.',
      [logs],
    );
  }
  found ||= CATALOG.unknown;
  const explanation =
    code === 'clock_skew' && Number.isFinite(details?.offsetSeconds)
      ? `${found.explanation} (About ${Math.round(Math.abs(details.offsetSeconds) / 60)} minute(s) off.)`
      : found.explanation;
  return { code, message, details, ...found, explanation, known: Boolean(CATALOG[code]) };
}

export const isProblem = (code) => !INFO_CODES.has(code) && code !== 'failed';
export const DOCTOR_COMMAND = 'sudo yuktiops-agent doctor';
export const AGENT_COMMANDS = {
  status: 'yuktiops-agent status',
  restart,
  logs: 'sudo journalctl -u yuktiops-agent -f',
  doctor: DOCTOR_COMMAND,
  uninstall: 'sudo yuktiops-agent uninstall',
};

export const NO_DATA_DIAGNOSIS = {
  kind: 'no_data',
  title: "We can't hear from this server yet",
  explanation:
    "Nothing has reached us from this server recently. If the server cannot reach us over HTTPS, it also cannot tell us why, so we can't see the reason from here. Work through the checklist below, or run the doctor on the server: it tests everything locally and prints the fix.",
  checklist: [
    {
      text: `The server must be able to reach ${API_HOST} on port 443 (outbound HTTPS). Check firewalls and security groups.`,
      command: `curl -I https://${API_HOST}/api/health`,
    },
    { text: 'The agent service must be running.', command: 'sudo systemctl status yuktiops-agent' },
    { text: 'The server clock should be correct.', command: 'sudo timedatectl set-ntp true' },
    {
      text: 'If the server uses a proxy, the agent must be told about it.',
      command: 'sudo systemctl show yuktiops-agent -p Environment',
    },
    { text: 'Read the latest agent log lines for the reason.', command: logs },
  ],
  doctorCommand: DOCTOR_COMMAND,
};
