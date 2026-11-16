import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root } from '../src/config.js';
import { setup, closeStore, register, drainIngest } from './helpers.js';

after(closeStore);
const agentScript = join(root, 'backend/scripts/agent.mjs');

/** Run the real agent script against a throwaway config directory; resolves when `done` is true. */
function runAgent(args, configDir, env = {}) {
  const child = spawn(process.execPath, [agentScript, ...args], {
    cwd: configDir, // a working directory with no .env: nothing may be written here
    env: {
      ...process.env,
      YUKTIOPS_CONFIG_DIR: configDir,
      YUKTIOPS_SAMPLE_SECONDS: '1',
      YUKTIOPS_SEND_SECONDS: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { out: '', err: '' };
  child.stdout.on('data', (d) => (output.out += d));
  child.stderr.on('data', (d) => (output.err += d));
  return { child, output };
}
async function until(check, child, output, seconds = 15) {
  for (let i = 0; i < seconds * 20; i++) {
    const value = await check();
    if (value) return value;
    if (finished(child)) throw new Error(`Agent exited early: ${output.err}${output.out}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out. Agent said: ${output.err}${output.out}`);
}
// A process ended by a signal has exitCode null but signalCode set, so check both.
const finished = (child) => child.exitCode !== null || child.signalCode !== null;
async function stop(child) {
  if (finished(child)) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

test(
  'the dev agent registers with the account key, keeps only its own credential, and reports samples',
  { timeout: 60000 },
  async () => {
    const { store, app } = await setup();
    const owner = await register(app, 'Agent Owner');
    const key = (await owner.client.post('/api/api-key')).body.key;
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const configDir = await mkdtemp(join(tmpdir(), 'yuktiops-agent-test-'));
    const children = [];
    try {
      const first = runAgent(['--register', '--key', key, '--api', endpoint], configDir, {
        AGENT_NAME: 'script-test-host',
      });
      children.push(first.child);
      const rows = async () => {
        await drainIngest(); // the dev agent's reports sit in the queue until a worker runs
        return store.client.serverMetric.findMany({ where: { orgId: owner.orgId } });
      };
      await until(async () => (await rows()).length >= 2, first.child, first.output);
      const agent = await store.find('agent', { name: 'script-test-host' });
      assert.equal(agent.status, 'healthy');
      assert.equal(agent.orgId, owner.orgId);
      const resource = await store.find('monitoredResource', { agentId: agent.id });
      assert.equal(typeof resource.labels.cpu, 'number');
      assert.equal(typeof resource.labels.memory, 'number');
      assert.ok(resource.labels.cores > 0);

      // Only the server's own credential is saved. The account key must not be left on the machine.
      const saved = await readFile(join(configDir, 'agent.env'), 'utf8');
      assert.match(saved, /^AGENT_TOKEN=agent_[a-f0-9]{64}$/m);
      assert.ok(saved.includes(`API_URL=${endpoint}`));
      assert.ok(!saved.includes(key), 'the API key is never written to disk');
      assert.ok(!first.output.out.includes(key) && !first.output.err.includes(key));
      if (process.platform !== 'win32')
        assert.equal((await stat(join(configDir, 'agent.env'))).mode & 0o777, 0o600);
      await stop(first.child);

      // Later runs need nothing but the saved credential and keep reporting for the same server.
      const before = (await rows()).length;
      const second = runAgent([], configDir);
      children.push(second.child);
      await until(async () => (await rows()).length > before, second.child, second.output);
      assert.equal((await store.list('agent', { orgId: owner.orgId })).length, 1);
      await stop(second.child);

      // A revoked server's agent notices and stops instead of retrying forever.
      const third = runAgent([], configDir);
      children.push(third.child);
      await until(async () => (await rows()).length > before + 1, third.child, third.output);
      await owner.client.post(`/api/agents/${agent.id}/revoke`);
      const [code] = await Promise.race([
        once(third.child, 'exit'),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Agent kept running')), 15000),
        ),
      ]);
      assert.equal(code, 1);
      assert.match(third.output.err, /Reinstall the agent/);
    } finally {
      for (const child of children) await stop(child);
      await new Promise((resolve) => server.close(resolve));
      await rm(configDir, { recursive: true, force: true });
    }
  },
);

test('the agent refuses to send credentials over plain http to a remote host', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'yuktiops-agent-test-'));
  try {
    const { child, output } = runAgent(
      ['--register', '--key', 'yk_live_x'.padEnd(30, 'x'), '--api', 'http://api.example.com'],
      configDir,
    );
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.match(output.err, /Refusing to send credentials over http/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('registering needs a real-looking account key', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'yuktiops-agent-test-'));
  try {
    const { child, output } = runAgent(
      ['--register', '--key', 'not-a-key', '--api', 'http://127.0.0.1:9'],
      configDir,
    );
    const [code] = await once(child, 'exit');
    assert.notEqual(code, 0);
    assert.match(output.err, /yk_live_/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
