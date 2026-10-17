import '../src/config.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../../node_modules/prisma/build/index.js', import.meta.url));
const result = spawnSync(process.execPath, [cli, 'validate'], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status || 0);
