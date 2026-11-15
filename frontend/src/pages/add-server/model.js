// Pure helpers for the Add-server wizard: choices, setup profile <-> YAML, install commands.

export const SYSTEMS = [
  {
    id: 'ubuntu',
    label: 'Ubuntu or Debian',
    hint: 'apt-based Linux, including Raspberry Pi OS',
    kind: 'deb',
  },
  {
    id: 'rhel',
    label: 'RHEL, Rocky, AlmaLinux or Amazon Linux',
    hint: 'yum or dnf based Linux',
    kind: 'rpm',
  },
  { id: 'linux', label: 'Another Linux', hint: 'Any Linux with systemd', kind: 'tar.gz' },
  { id: 'docker', label: 'Docker', hint: 'Run the agent as a container', kind: null },
];

export const COLLECTORS = [
  { key: 'cpu', label: 'Processor (CPU)', hint: 'How busy the processors are' },
  { key: 'memory', label: 'Memory (RAM)', hint: 'How much memory is used' },
  { key: 'swap', label: 'Swap', hint: 'Disk space used as extra memory' },
  { key: 'disk', label: 'Disk space', hint: 'How full each disk is' },
  { key: 'diskIo', label: 'Disk activity', hint: 'Reads and writes per second' },
  { key: 'network', label: 'Network traffic', hint: 'Data sent and received' },
  { key: 'load', label: 'Load average', hint: 'How much work is waiting' },
  {
    key: 'processes',
    label: 'Busiest programs',
    hint: 'The programs using the most CPU and memory',
  },
];

export const SEND_INTERVALS = [15, 30, 60, 120, 300];
export const SAMPLE_INTERVALS = [5, 10, 15, 30, 60];

export const defaultSettings = () => ({
  sendIntervalSeconds: 30,
  sampleIntervalSeconds: 10,
  collectors: Object.fromEntries(COLLECTORS.map((c) => [c.key, true])),
});

/** The setup profile as the YAML shown in "Show config file". */
export function toYaml(settings) {
  return [
    '# How often the agent measures and reports (seconds)',
    `sendIntervalSeconds: ${settings.sendIntervalSeconds}`,
    `sampleIntervalSeconds: ${settings.sampleIntervalSeconds}`,
    '# What it measures (true = on, false = off)',
    'collectors:',
    ...COLLECTORS.map((c) => `  ${c.key}: ${settings.collectors[c.key]}`),
    '',
  ].join('\n');
}

/** Parse the YAML above (only this flat shape). Returns { settings } or { error } in plain words. */
export function fromYaml(text) {
  const result = { sendIntervalSeconds: null, sampleIntervalSeconds: null, collectors: {} };
  let inCollectors = false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\s+#.*$/, '');
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const match = /^(\s*)([A-Za-z]+):\s*(.*?)\s*$/.exec(raw);
    const where = `Line ${i + 1}`;
    if (!match) return { error: `${where}: expected "name: value".` };
    const [, indent, key, value] = match;
    if (!indent) {
      inCollectors = false;
      if (key === 'collectors') {
        if (value) return { error: `${where}: "collectors" holds a list below it.` };
        inCollectors = true;
      } else if (key === 'sendIntervalSeconds' || key === 'sampleIntervalSeconds') {
        if (!/^\d+$/.test(value)) return { error: `${where}: ${key} must be a whole number.` };
        result[key] = Number(value);
      } else return { error: `${where}: "${key}" is not a setting we know.` };
    } else {
      if (!inCollectors) return { error: `${where}: unexpected indent.` };
      if (!COLLECTORS.some((c) => c.key === key))
        return { error: `${where}: "${key}" is not a collector we know.` };
      if (value !== 'true' && value !== 'false') return { error: `${where}: use true or false.` };
      result.collectors[key] = value === 'true';
    }
  }
  const { sendIntervalSeconds: send, sampleIntervalSeconds: sample } = result;
  if (send === null || sample === null) return { error: 'Both intervals are required.' };
  if (send < 15 || send > 300) return { error: 'sendIntervalSeconds must be between 15 and 300.' };
  if (sample < 5 || sample > 60)
    return { error: 'sampleIntervalSeconds must be between 5 and 60.' };
  if (sample > send)
    return { error: 'The measuring interval cannot be longer than the reporting interval.' };
  for (const c of COLLECTORS)
    if (typeof result.collectors[c.key] !== 'boolean')
      return { error: `Missing collector "${c.key}".` };
  return { settings: result };
}

export const DEFAULT_INSTALL_HOST = 'https://get.yuktiops.com';
export const KEY_PATTERN = /^yk_live_[A-Za-z0-9_-]{8,}$/;

/** The one-line installer. Uses the release info's template when the API gave one. */
export function oneCommand({ release, key, setupId, docker, apiUrl }) {
  const k = key || 'YOUR_API_KEY';
  let command;
  if (release?.install?.commandTemplate) {
    command = release.install.commandTemplate
      .replace('<API_KEY>', k)
      .replace(/\[--setup=<SETUP_ID>\]/, setupId ? `--setup=${setupId}` : '')
      .replace(/<SETUP_ID>/, setupId || '')
      .trim();
  } else {
    command = `curl -fsSL ${release?.installScriptUrl || DEFAULT_INSTALL_HOST} | sudo bash -s -- --key=${k}${setupId ? ` --setup=${setupId}` : ''}`;
    if (apiUrl && /localhost|127\.0\.0\.1/.test(apiUrl)) command += ` --api=${apiUrl}`;
  }
  return docker ? `${command} --docker` : command;
}

export function dockerRun({ release, key, apiUrl, docker }) {
  const image = release?.docker
    ? `${release.docker.image}:${release.docker.tag}`
    : 'ghcr.io/yuktiops/agent:latest';
  const local = apiUrl && /localhost|127\.0\.0\.1/.test(apiUrl);
  const k = key || 'YOUR_API_KEY';
  return [
    'docker run -d --name yuktiops-agent --restart unless-stopped \\',
    `  -e YUKTIOPS_API_KEY=${k} \\`,
    ...(local ? [`  -e YUKTIOPS_API_URL=${apiUrl} \\`] : []),
    '  -v yuktiops-agent:/var/lib/yuktiops \\',
    ...(docker ? ['  -v /var/run/docker.sock:/var/run/docker.sock:ro \\'] : []),
    `  ${image}`,
  ].join('\n');
}

export function dockerCompose({ release, key, apiUrl, docker }) {
  const image = release?.docker
    ? `${release.docker.image}:${release.docker.tag}`
    : 'ghcr.io/yuktiops/agent:latest';
  const local = apiUrl && /localhost|127\.0\.0\.1/.test(apiUrl);
  return [
    'services:',
    '  yuktiops-agent:',
    `    image: ${image}`,
    '    container_name: yuktiops-agent',
    '    restart: unless-stopped',
    '    environment:',
    `      YUKTIOPS_API_KEY: ${key || 'YOUR_API_KEY'}`,
    ...(local ? [`      YUKTIOPS_API_URL: ${apiUrl}`] : []),
    '    volumes:',
    '      - yuktiops-agent:/var/lib/yuktiops',
    ...(docker ? ['      - /var/run/docker.sock:/var/run/docker.sock:ro'] : []),
    'volumes:',
    '  yuktiops-agent:',
    '',
  ].join('\n');
}

/** agent.yaml for the Download tab (the file `register` would write). */
export function agentYaml({ apiUrl, setupId }) {
  return [
    '# YuktiOps agent settings. Put this at /etc/yuktiops/agent.yaml',
    `api_url: "${apiUrl || 'https://api.yuktiops.com'}"`,
    ...(setupId ? [`setup_id: "${setupId}"`] : []),
    '',
  ].join('\n');
}

export const AFTER_INSTALL = {
  status: 'yuktiops-agent status',
  restart: 'sudo systemctl restart yuktiops-agent',
  logs: 'sudo journalctl -u yuktiops-agent -f',
  doctor: 'sudo yuktiops-agent doctor',
  uninstall: 'sudo yuktiops-agent uninstall',
};
