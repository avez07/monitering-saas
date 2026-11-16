// Plain-language install guides for every tab of the install step. Pure data, so it can be tested
// and turned into one text file ("Copy all steps", "Print guide").
import { AFTER_INSTALL, oneCommand } from './model.js';

const CHECK = {
  title: 'Check that it worked',
  what: 'Asks the agent whether it is running and can reach your account.',
  commands: AFTER_INSTALL.status,
  expect: 'Status: running, and a line saying it is connected to your account.',
  trouble: [
    ['It says "not found"', 'Open a new terminal window so your shell picks up the new program.'],
    ['It says "not registered"', 'Run the connect step again with your API key.'],
    ['Anything else', `Run ${AFTER_INSTALL.doctor}. It checks each step and says how to fix it.`],
  ],
};

const isLocal = (apiUrl) => !!apiUrl && /localhost|127\.0\.0\.1/.test(apiUrl);

export function oneCommandSteps({ release, key, setupId, docker, apiUrl }) {
  return [
    {
      title: 'Log in to your server',
      what: 'Open a terminal on the server, for example with SSH. You need an account that can use sudo.',
      commands: 'ssh YOUR_USER@YOUR_SERVER',
      expect: 'A prompt on your server, like "you@server:~$".',
      trouble: [
        ['Permission denied', 'Check the user name and that your SSH key or password is right.'],
        ['Connection timed out', 'Check the server address and that port 22 is open.'],
      ],
    },
    {
      title: 'Run the install command',
      label: 'install command',
      what: 'Downloads the agent, checks its SHA-256 fingerprint, installs it as a system service and connects it to your account.',
      commands: oneCommand({ release, key, setupId, docker, apiUrl }),
      expect: 'A few lines ending with "Installed" and "Agent started".',
      trouble: [
        [
          'curl: command not found',
          'Install curl first: sudo apt install curl, or sudo dnf install curl.',
        ],
        [
          'Could not resolve host',
          'The server has no internet access. It needs to reach us on port 443.',
        ],
        ['Invalid API key', 'Copy the key again from the box above. It starts with yk_live_.'],
      ],
    },
    CHECK,
  ];
}

export function packageSteps({ kind, file, key, setupId, apiUrl }) {
  const name = file?.name || 'the downloaded file';
  const register = `sudo yuktiops-agent register --key=${key || 'YOUR_API_KEY'}${setupId ? ` --setup=${setupId}` : ''}${isLocal(apiUrl) ? ` --api=${apiUrl}` : ''}`;
  const download = {
    title: 'Download the package',
    what: `Saves ${name} on your server. Download it on your computer and copy it over with scp, or fetch it on the server with curl.`,
    commands: file?.url ? `curl -fLO ${file.url}` : undefined,
    expect: `A file called ${name} in the current folder.`,
    trouble: [
      ['The download is blocked', 'Use the Download button and copy the file over with scp.'],
    ],
  };
  const verify = {
    title: 'Check the file is genuine',
    what: 'Compares the file with the published SHA-256 fingerprint so you know it was not changed.',
    commands: file?.sha256 ? `echo "${file.sha256}  ${name}" | sha256sum -c -` : undefined,
    expect: `${name}: OK`,
    trouble: [['It says FAILED', 'Download the file again. Do not install a file that fails.']],
  };
  const connect = {
    title: 'Connect it to your account',
    what: 'Saves your API key on the server and registers it, so it shows up in your dashboard.',
    commands: register,
    expect: 'A message that the server was registered.',
    trouble: [
      ['Invalid API key', 'Copy the key again from the box above.'],
      ['Cannot reach the API', 'The server needs to reach us on port 443 (HTTPS).'],
    ],
  };
  const start = {
    title: 'Start it',
    what: 'Starts the agent now and every time the server boots.',
    commands: 'sudo systemctl enable --now yuktiops-agent',
    expect: 'No output, or "Created symlink ... yuktiops-agent.service".',
    trouble: [['Unit not found', 'The install step did not finish. Run it again.']],
  };
  if (kind === 'deb')
    return [
      download,
      verify,
      {
        title: 'Install the package',
        what: 'Installs the agent program, a system user for it and its service file.',
        commands: `sudo dpkg -i ${name}`,
        expect: 'Setting up yuktiops-agent ...',
        trouble: [['Dependency problems', 'Run sudo apt -f install, then repeat this step.']],
      },
      connect,
      start,
      CHECK,
    ];
  if (kind === 'rpm')
    return [
      download,
      verify,
      {
        title: 'Install the package',
        what: 'Installs the agent program, a system user for it and its service file.',
        commands: `sudo rpm -i ${name}`,
        expect: 'Updating / installing ... yuktiops-agent',
        trouble: [['Already installed', 'Use sudo rpm -U to upgrade an existing install.']],
      },
      connect,
      start,
      CHECK,
    ];
  return [
    download,
    verify,
    {
      title: 'Unpack it',
      what: 'Extracts the program and its service file into the current folder.',
      commands: `tar -xzf ${name}`,
      expect: 'The files yuktiops-agent and yuktiops-agent.service appear (check with ls).',
    },
    {
      title: 'Put the program in place',
      what: 'Copies the program to a folder on the PATH so you can run it from anywhere.',
      commands: 'sudo install -m 0755 yuktiops-agent /usr/local/bin/yuktiops-agent',
      expect: 'No output.',
    },
    {
      title: 'Create a user and folders',
      what: 'The agent runs as its own user that cannot log in, and keeps its settings and buffer in two folders.',
      commands: [
        'sudo useradd --system --no-create-home --shell /usr/sbin/nologin yuktiops',
        'sudo mkdir -p /etc/yuktiops /var/lib/yuktiops',
        'sudo chown yuktiops: /var/lib/yuktiops',
      ].join('\n'),
      expect: 'No output. "user already exists" is fine.',
    },
    {
      title: 'Install the service file',
      what: 'Tells systemd how to run the agent.',
      commands:
        'sudo cp yuktiops-agent.service /etc/systemd/system/\nsudo systemctl daemon-reload',
      expect: 'No output.',
      trouble: [['No such file', 'Run ls in the folder where you unpacked the file.']],
    },
    connect,
    start,
    CHECK,
  ];
}

export function dockerSteps({ command, compose, desktop }) {
  return [
    {
      title: 'Check Docker is running',
      what: 'Asks Docker for its version. If it answers, you can go on.',
      commands: 'docker version',
      expect: 'A Client and a Server section.',
      trouble: [
        [
          'Cannot connect to the Docker daemon',
          desktop
            ? 'Start Docker Desktop and wait until it says it is running.'
            : 'Start Docker with: sudo systemctl start docker',
        ],
      ],
    },
    {
      title: 'Start the agent container',
      what: 'Runs the agent as a container that restarts by itself. The mounts let it see the host, not only its own container.',
      commands: command,
      expect: 'A long container id.',
      trouble: [
        [
          'An error that mentions C:\\Program Files\\Git',
          'Git Bash rewrote a path. Use the PowerShell version, or the Git Bash one that starts with MSYS_NO_PATHCONV=1.',
        ],
        ['The name is already in use', 'Run docker rm -f yuktiops-agent, then repeat this step.'],
      ],
    },
    {
      title: 'Or use Docker Compose',
      what: 'The same thing as a compose file. Save it as compose.yaml and run docker compose up -d. Skip this if you used the command above.',
      commands: compose,
      expect: 'Container yuktiops-agent Started.',
    },
    {
      title: 'Check that it worked',
      what: 'Asks the agent inside the container for its status.',
      commands: 'docker exec yuktiops-agent yuktiops-agent status',
      expect: 'Status: running, and a line saying it is connected to your account.',
      trouble: [
        [
          'Anything else',
          'Run docker logs yuktiops-agent and read the last lines, or docker exec yuktiops-agent yuktiops-agent doctor.',
        ],
      ],
    },
  ];
}

/** All steps of a guide as plain text, for "Copy all steps" and the print view. */
export function stepsToText(title, steps) {
  const lines = [title, ''];
  steps.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.title}`, `   ${s.what}`);
    if (s.commands) lines.push('', ...s.commands.split('\n').map((l) => `   ${l}`), '');
    if (s.expect) lines.push(`   You should see: ${s.expect}`);
    for (const [problem, fix] of s.trouble || []) lines.push(`   If ${problem}: ${fix}`);
    lines.push('');
  });
  return lines.join('\n');
}
