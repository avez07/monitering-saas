// Shared settings for the browser tests: which ports, which database. Override with E2E_* variables.
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const envFile = new URL('../.env', import.meta.url);
const dotenv = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
const baseUrl = process.env.E2E_DATABASE_URL || process.env.DATABASE_URL || dotenv.DATABASE_URL;
const fallback = 'postgresql://yuktiops:yuktiops_local_dummy@localhost:5432/yuktiops?schema=public';

export const API_PORT = Number(process.env.E2E_API_PORT || 4060);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT || 5173);
export const WEB_URL = `http://localhost:${WEB_PORT}`;
export const API_URL = `http://localhost:${API_PORT}`;
export const MAILPIT_URL = process.env.E2E_MAILPIT_URL || 'http://localhost:8025';
/** A database of its own, so browser tests never touch development data. */
export const DATABASE_URL = (() => {
  if (process.env.E2E_DATABASE_URL) return process.env.E2E_DATABASE_URL;
  const url = new URL(baseUrl || fallback);
  url.pathname = '/yuktiops_e2e';
  return url.toString();
})();
