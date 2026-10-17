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
  DEMO_MODE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  DEMO_EMAIL: z.string().email().default('demo@pulse.local'),
  DEMO_PASSWORD: z.string().min(10),
  JWT_SECRET: z.string().min(32),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  MIMIR_URL: z.string().url().default('http://localhost:9009'),
  LOKI_URL: z.string().url().default('http://localhost:3100'),
  TEMPO_URL: z.string().url().default('http://localhost:3200'),
  TEMPO_OTLP_URL: z.string().url().default('http://localhost:4318'),
  BILLING_PROVIDER: z.enum(['mock']).default('mock'),
  BILLING_WEBHOOK_SECRET: z.string().min(20),
  EMAIL_PROVIDER: z.enum(['local', 'smtp']).default('local'),
  EMAIL_FROM: z.string().email().default('alerts@pulse.local'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  INGEST_BYTES_PER_MINUTE: z.coerce.number().default(10485760),
  QUERY_REQUESTS_PER_MINUTE: z.coerce.number().default(120),
  WORKER_INTERVAL_MS: z.coerce.number().default(30000),
});
export const config = schema.parse(process.env);
if (config.NODE_ENV === 'production' && (config.DEMO_MODE || config.JWT_SECRET.includes('dummy'))) {
  throw new Error('Production requires DEMO_MODE=false and a non-dummy JWT_SECRET.');
}
