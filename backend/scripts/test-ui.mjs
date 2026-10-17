// Own the preview process directly: avoids shell process-group cleanup hangs on Windows.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { config, root } from '../src/config.js';

const frontendPort = process.env.FRONTEND_PORT || 5173;
const frontendUrl = `http://127.0.0.1:${frontendPort}`;
async function ready() {
  try {
    const responses = await Promise.all([
      fetch(frontendUrl, { signal: AbortSignal.timeout(1000) }),
      fetch(`http://127.0.0.1:${config.PORT}/api/health`, { signal: AbortSignal.timeout(1000) }),
    ]);
    await Promise.all(responses.map((response) => response.arrayBuffer()));
    return responses.every((response) => response.ok);
  } catch {
    return false;
  }
}
let preview;
try {
  if (!(await ready())) {
    preview = spawn(process.execPath, [fileURLToPath(new URL('./preview.mjs', import.meta.url))], {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
    });
    const deadline = Date.now() + 60000;
    while (!(await ready())) {
      if (preview.exitCode !== null)
        throw new Error('Preview exited before it was ready. Check ports and .env.');
      if (Date.now() > deadline) throw new Error('Preview did not become ready within 60 seconds.');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  const cli = fileURLToPath(new URL('../../node_modules/@playwright/test/cli.js', import.meta.url));
  const tests = spawn(process.execPath, [cli, 'test', ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  const [code] = await once(tests, 'exit');
  process.exitCode = code ?? 1;
} finally {
  if (preview && preview.exitCode === null) {
    const exited = once(preview, 'exit');
    preview.kill('SIGTERM');
    const force = setTimeout(() => preview.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(force);
  }
}
