import { config } from '../src/config.js';

/** Integration tests always use their own database, never the development one. */
export function testDatabaseUrl() {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const url = new URL(config.DATABASE_URL);
  url.pathname = '/yuktiops_test';
  return url.toString();
}
