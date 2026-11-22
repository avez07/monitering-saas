// Cross-platform launcher: npm run dev:terminals
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
const win = process.platform === 'win32';
const r = win
  ? spawnSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'dev-terminals.ps1')], { stdio: 'inherit' })
  : spawnSync('bash', [path.join(here, 'dev-terminals.sh')], { stdio: 'inherit' });
process.exit(r.status ?? 1);
