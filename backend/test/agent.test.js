import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root } from '../src/config.js';
import { setup, closeStore, register } from './helpers.js';

after(closeStore);
const agentScript = join(root, 'backend/scripts/agent.mjs');

test(
  'the dev agent enrolls, saves its credential to its own config directory, and reports measurements',
  { timeout: 30000 },
  async () => {
    const { store, app } = await setup();
    const owner = await register(app, 'Agent Owner');
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const configDir = await mkdtemp(join(tmpdir(), 'yuktiops-agent-test-'));
    let child;
    try {
      const enrollment = await owner.client
        .post('/api/agents/enrollment-tokens')
        .send({ projectId: owner.project.id });
      child = spawn(
        process.execPath,
        [agentScript, '--enroll', enrollment.body.token, '--api', endpoint],
        {
          cwd: configDir, // a working directory with no .env: the credential must not land here
          env: { ...process.env, YUKTIOPS_CONFIG_DIR: configDir, AGENT_NAME: 'script-test-host' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let errors = '';
      child.stderr.on('data', (data) => (errors += data.toString()));
      child.stdout.resume();
      let resource;
      for (let i = 0; i < 200; i++) {
        resource = await store.find('monitoredResource', { name: 'script-test-host' });
        if (resource?.labels?.cores) break;
        if (child.exitCode !== null) throw new Error(`Agent exited early: ${errors}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(resource?.labels?.cores, errors || 'No heartbeat received from the agent process');
      assert.equal(typeof resource.labels.cpu, 'number');
      assert.equal(typeof resource.labels.memory, 'number');
      assert.equal((await store.find('agent', { name: 'script-test-host' })).status, 'healthy');
      const saved = await readFile(join(configDir, 'agent.env'), 'utf8');
      assert.match(saved, /^AGENT_TOKEN=agent_[a-f0-9]{64}$/m);
      assert.ok(saved.includes(`API_URL=${endpoint}`));
      if (process.platform !== 'win32')
        assert.equal((await stat(join(configDir, 'agent.env'))).mode & 0o777, 0o600);
    } finally {
      if (child && child.exitCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
      await new Promise((resolve) => server.close(resolve));
      await rm(configDir, { recursive: true, force: true });
    }
  },
);

test('the agent refuses to send credentials over plain http to a remote host', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'yuktiops-agent-test-'));
  try {
    const child = spawn(
      process.execPath,
      [agentScript, '--enroll', 'enroll_x'.padEnd(30, 'x'), '--api', 'http://api.example.com'],
      {
        env: { ...process.env, YUKTIOPS_CONFIG_DIR: configDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let errors = '';
    child.stderr.on('data', (data) => (errors += data.toString()));
    child.stdout.resume();
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.match(errors, /Refusing to send credentials over http/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
