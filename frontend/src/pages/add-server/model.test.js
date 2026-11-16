import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dockerCompose, dockerRun } from './model.js';

const base = { key: 'yk_live_abcdefgh1234', docker: true };

test('linux: host mounts, docker socket, backslash continuations', () => {
  const out = dockerRun({ ...base, platform: 'linux' });
  assert.match(out, /--pid host --network host/);
  assert.match(out, /-v \/:\/host:ro -e HOST_ROOT=\/host/);
  assert.match(out, /-v \/var\/run\/docker\.sock:\/var\/run\/docker\.sock:ro/);
  assert.match(out, / \\\n/);
  assert.ok(!out.includes('`'));
  assert.ok(!out.startsWith('MSYS_NO_PATHCONV'));
});

test('linux: no docker socket when containers are off', () => {
  assert.ok(!dockerRun({ ...base, docker: false }).includes('docker.sock'));
});

test('windows PowerShell: backtick continuations, no MSYS prefix', () => {
  const out = dockerRun({ ...base, platform: 'windows', shell: 'powershell' });
  assert.match(out, / `\n/);
  assert.ok(!out.includes(' \\\n'));
  assert.ok(!out.includes('MSYS_NO_PATHCONV'));
  assert.match(out, /-v \/:\/host:ro/);
});

test('windows Git Bash: MSYS_NO_PATHCONV=1 prefix and backslashes', () => {
  const out = dockerRun({ ...base, platform: 'windows', shell: 'gitbash' });
  assert.ok(out.startsWith('MSYS_NO_PATHCONV=1 docker run'));
  assert.match(out, / \\\n/);
  assert.ok(!out.includes('`'));
});

test('macOS: same as Linux shell syntax', () => {
  assert.equal(dockerRun({ ...base, platform: 'mac' }), dockerRun({ ...base, platform: 'linux' }));
});

test('local API url is passed through', () => {
  assert.match(dockerRun({ ...base, apiUrl: 'http://localhost:3000' }), /YUKTIOPS_API_URL=http:\/\/localhost:3000/);
});

test('compose has the same mounts', () => {
  const out = dockerCompose(base);
  assert.match(out, /pid: host/);
  assert.match(out, /network_mode: host/);
  assert.match(out, /HOST_ROOT: \/host/);
  assert.match(out, /- \/:\/host:ro/);
  assert.match(out, /docker\.sock/);
  assert.ok(!dockerCompose({ ...base, docker: false }).includes('docker.sock'));
});

test('guide: package steps end with a status check and agent.yaml is commented', async () => {
  const { packageSteps, stepsToText } = await import('./guide.js');
  const { agentYaml } = await import('./model.js');
  const file = { name: 'yuktiops-agent_1.0_amd64.deb', url: 'https://x/y.deb', sha256: 'abc' };
  for (const kind of ['deb', 'rpm', 'tar.gz']) {
    const steps = packageSteps({ kind, file, key: 'yk_live_abcdefgh1234' });
    assert.equal(steps.at(-1).commands, 'yuktiops-agent status');
    assert.ok(steps.every((s) => s.what && (s.commands || s.expect)));
    assert.match(stepsToText('t', steps), /1\. Download the package/);
  }
  assert.match(packageSteps({ kind: 'deb', file }).map((s) => s.commands).join('\n'), /dpkg -i/);
  assert.match(agentYaml({ apiUrl: 'https://a' }), /^# YuktiOps/);
});
