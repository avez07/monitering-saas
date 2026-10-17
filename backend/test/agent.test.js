import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config, root } from '../src/config.js';
import { MemoryStore } from '../src/data/store.js';
import { seed } from '../src/data/seed.js';
import { Limits } from '../src/services/limits.js';
import { createApp } from '../src/app.js';

test(
  'the actual host-agent script enrolls, saves its credential to .env, and reports measurements',
  { timeout: 20000 },
  async () => {
    const store = new MemoryStore();
    await seed(store, { tenants: 1 });
    const server = createApp(store, new Limits()).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    await mkdir(join(root, 'backend/data'), { recursive: true });
    const directory = await mkdtemp(join(root, 'backend/data/agent-test-'));
    const envPath = join(directory, '.env');
    let child;
    try {
      await writeFile(envPath, `API_PUBLIC_URL=${endpoint}\nAGENT_TOKEN=\n`);
      const login = await (await fetch(`${endpoint}/api/auth/demo`, { method: 'POST' })).json();
      const headers = {
        Authorization: `Bearer ${login.token}`,
        'Content-Type': 'application/json',
      };
      const workspace = await (await fetch(`${endpoint}/api/bootstrap`, { headers })).json();
      const enrollment = await (
        await fetch(`${endpoint}/api/agents/enrollment-tokens`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ projectId: workspace.projects[0].id }),
        })
      ).json();
      child = spawn(
        process.execPath,
        [join(root, 'backend/scripts/agent.mjs'), '--enroll', enrollment.token],
        {
          cwd: directory,
          env: {
            ...process.env,
            API_PUBLIC_URL: endpoint,
            AGENT_TOKEN: '',
            AGENT_NAME: 'script-verification-host',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let errors = '';
      child.stderr.on('data', (data) => {
        errors += data.toString();
      });
      child.stdout.resume();
      let resource;
      for (let i = 0; i < 100; i++) {
        resource = await store.find('monitoredResource', { name: 'script-verification-host' });
        if (resource?.labels?.cores) break;
        if (child.exitCode !== null) throw new Error(`Agent exited early: ${errors}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(
        resource?.labels?.cores,
        errors || 'No heartbeat received from actual agent process',
      );
      assert.equal(typeof resource.labels.cpu, 'number');
      assert.equal(typeof resource.labels.memory, 'number');
      assert.match(await readFile(envPath, 'utf8'), /^AGENT_TOKEN=agent_[a-f0-9]{64}$/m);
      assert.equal(
        (await store.find('agent', { name: 'script-verification-host' })).status,
        'healthy',
      );
    } finally {
      if (child && child.exitCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
      await new Promise((resolve) => server.close(resolve));
      await unlink(envPath);
      await rmdir(directory);
    }
  },
);
