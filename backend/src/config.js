import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const root = fileURLToPath(new URL('../../', import.meta.url));
dotenv.config({ path: `${root}/.env`, quiet: true });
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  APP_URL: z.string().url().default('http://localhost:5173'),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  // Express "trust proxy" value: a hop count ("1"), "loopback", or a comma-separated list of CIDRs.
  TRUST_PROXY: z.string().default('loopback'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required.'),
  BILLING_PROVIDER: z.enum(['mock']).default('mock'),
  BILLING_WEBHOOK_SECRET: z.string().min(20),
  EMAIL_PROVIDER: z.enum(['local', 'smtp']).default('local'),
  EMAIL_FROM: z.string().email().default('alerts@yuktiops.com'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  WORKER_INTERVAL_MS: z.coerce.number().default(30000),
});

/** Parse and validate environment variables. Exported so production rules can be tested. */
export function loadConfig(env = process.env) {
  const parsed = schema.parse(env);
  if (parsed.NODE_ENV === 'production') {
    const problems = [];
    if (!parsed.APP_URL.startsWith('https://')) problems.push('APP_URL must use https.');
    if (!parsed.API_PUBLIC_URL.startsWith('https://'))
      problems.push('API_PUBLIC_URL must use https.');
    if (/dummy|change-me|example|local/i.test(parsed.BILLING_WEBHOOK_SECRET))
      problems.push('BILLING_WEBHOOK_SECRET must be a real random secret.');
    if (/dummy|local/i.test(parsed.DATABASE_URL))
      problems.push('DATABASE_URL must not use the local dummy credentials.');
    if (problems.length) throw new Error(`Unsafe production configuration: ${problems.join(' ')}`);
  }
  return parsed;
}

export const config = loadConfig();

/** Express accepts numbers, booleans, or strings for "trust proxy"; env values are always strings. */
export function trustProxyValue(value = config.TRUST_PROXY) {
  if (/^\d+$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value.includes(',') ? value.split(',').map((v) => v.trim()) : value;
}
