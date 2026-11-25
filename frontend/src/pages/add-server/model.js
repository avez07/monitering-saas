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

/** Where Docker runs. Linux is recommended; Docker Desktop runs everything inside a Linux VM. */
export const DOCKER_PLATFORMS = [
  {
    id: 'linux',
    label: 'Linux server (recommended)',
    hint: 'Docker Engine on a Linux machine. The agent sees the whole machine.',
  },
  {
    id: 'windows',
    label: 'Windows (Docker Desktop)',
    hint: 'Run the command in PowerShell, or in Git Bash.',
  },
  { id: 'mac', label: 'macOS (Docker Desktop)', hint: 'Run the command in Terminal.' },
];
export const WINDOWS_SHELLS = [
  { id: 'powershell', label: 'PowerShell' },
  { id: 'gitbash', label: 'Git Bash' },
];
export const DOCKER_DESKTOP_NOTE =
  "On Docker Desktop the agent monitors Docker's Linux virtual machine and your containers, not your Windows or Mac computer itself.";

const isLocalApi = (apiUrl) => !!apiUrl && /localhost|127\.0\.0\.1/.test(apiUrl);
// Override at build time with VITE_YUKTIOPS_AGENT_IMAGE (for example yuktiops-agent:local).
export const AGENT_IMAGE_DEFAULT = 'yuktiops/yuktiops-agent:latest';
const imageOf = (release) =>
  import.meta.env?.VITE_YUKTIOPS_AGENT_IMAGE ||
  (release?.docker ? `${release.docker.image}:${release.docker.tag}` : AGENT_IMAGE_DEFAULT);

/** Shown next to the Docker command when the pull is refused (image not public yet). */
export const DOCKER_DENIED_HELP = {
  title: 'See "denied" or "pull access denied"?',
  body: 'The image is not public yet. Build it from this repository instead, then run the same command with the image yuktiops-agent:local.',
  build: 'docker build -t yuktiops-agent:local -f agent/Dockerfile agent',
  powershell: 'docker build -t yuktiops-agent:local -f agent/Dockerfile agent',
  bash: 'docker build -t yuktiops-agent:local -f agent/Dockerfile agent',
  image: 'yuktiops-agent:local',
  login: 'docker login',
};

/**
 * `docker run` for the agent. `platform`: linux | windows | mac. For windows, `shell` is
 * powershell (backtick line breaks) or gitbash (MSYS_NO_PATHCONV=1 so Git Bash leaves
 * /var/run/docker.sock alone instead of turning it into C:\Program Files\Gitar\...).
 */
export function dockerRun({
  release,
  key,
  apiUrl,
  docker,
  platform = 'linux',
  shell = 'powershell',
}) {
  const ps = platform === 'windows' && shell === 'powershell';
  const cont = ps ? ' `' : ' \\';
  const lines = [
    'docker run -d --name yuktiops-agent --restart unless-stopped',
    '--pid host --network host',
    '-v /:/host:ro -e HOST_ROOT=/host',
    `-e YUKTIOPS_API_KEY=${key || 'YOUR_API_KEY'}`,
    ...(isLocalApi(apiUrl) ? [`-e YUKTIOPS_API_URL=${apiUrl}`] : []),
    '-v yuktiops-agent:/var/lib/yuktiops',
    ...(docker
      ? [
          '-v /var/run/docker.sock:/var/run/docker.sock:ro',
          // The agent runs as a non-root user; without the socket's group it cannot list containers.
          // Docker Desktop (Windows, Mac): the socket belongs to root (group 0). Linux: its own group.
          platform === 'linux' ? "--group-add $(stat -c '%g' /var/run/docker.sock)" : '--group-add 0',
        ]
      : []),
    imageOf(release),
  ];
  const body = lines.map((l, i) => (i === 0 ? l : `  ${l}`));
  const joined = body.map((l, i) => (i < body.length - 1 ? l + cont : l)).join('\n');
  return platform === 'windows' && shell === 'gitbash' ? `MSYS_NO_PATHCONV=1 ${joined}` : joined;
}

/** The same mounts as docker run, as a compose file. Compose is not shell-specific. */
export function dockerCompose({ release, key, apiUrl, docker }) {
  return [
    'services:',
    '  yuktiops-agent:',
    `    image: ${imageOf(release)}`,
    '    container_name: yuktiops-agent',
    '    restart: unless-stopped',
    '    pid: host',
    '    network_mode: host',
    ...(docker
      ? [
          '    # Lets the non-root agent read the Docker socket. Docker Desktop: 0. Linux: DOCKER_GID=$(stat -c %g /var/run/docker.sock)',
          '    group_add:',
          '      - "${DOCKER_GID:-0}"',
        ]
      : []),
    '    environment:',
    `      YUKTIOPS_API_KEY: ${key || 'YOUR_API_KEY'}`,
    '      HOST_ROOT: /host',
    ...(isLocalApi(apiUrl) ? [`      YUKTIOPS_API_URL: ${apiUrl}`] : []),
    '    volumes:',
    '      - yuktiops-agent:/var/lib/yuktiops',
    '      - /:/host:ro',
    ...(docker ? ['      - /var/run/docker.sock:/var/run/docker.sock:ro'] : []),
    'volumes:',
    '  yuktiops-agent:',
    '',
  ].join('\n');
}

/** agent.yaml for the Download tab (the file `register` would write). */
export function agentYaml({ apiUrl, setupId }) {
  return [
    '# YuktiOps agent settings.',
    '# Save this file as /etc/yuktiops/agent.yaml, then restart the agent:',
    '#   sudo systemctl restart yuktiops-agent',
    '#',
    '# Where the agent sends its data. Leave this as it is unless we told you otherwise.',
    `api_url: "${apiUrl || 'https://api.yuktiops.com'}"`,
    ...(setupId
      ? [
          '',
          '# Which setup profile (what to measure and how often) this server uses.',
          '# You can change the profile later in the dashboard, no need to edit this file.',
          `setup_id: "${setupId}"`,
        ]
      : []),
    '',
    '# Your API key is NOT stored here. Run "sudo yuktiops-agent register --key=YOUR_API_KEY"',
    '# once and the agent keeps a private credential in /var/lib/yuktiops.',
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
