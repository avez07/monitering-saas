import { createHash, randomBytes } from 'node:crypto';
import { expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { API_URL, DATABASE_URL, MAILPIT_URL, WEB_URL } from './env.mjs';

export const PASSWORD = 'correct-horse-battery';
export const unique = (prefix) =>
  `${prefix}-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
export const emailFor = (prefix) => `${unique(prefix)}@example.com`;

let client;
/** Direct database access for things a customer cannot do (backdating history, ageing a server). */
export const db = () =>
  (client ||= new PrismaClient({ datasources: { db: { url: DATABASE_URL } } }));
export const closeDb = () => client?.$disconnect();

/** Sign up through the real form; ends on the signed-in app. */
export async function signUp(
  page,
  { name = 'Test Owner', org = 'Test Company', email, password = PASSWORD },
) {
  await page.goto('/register');
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Company or organization').fill(org);
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
}

export async function signIn(page, { email, password = PASSWORD }) {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /Sign in/ }).click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
}

// ---- Mailpit ---------------------------------------------------------------------------------
/** The newest email to `to` whose subject matches, as { subject, text }. Waits for it to arrive. */
export async function waitForMail(to, subject, { timeout = 20000 } = {}) {
  let found;
  await expect
    .poll(
      async () => {
        const search = await fetch(
          `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
        );
        const { messages = [] } = await search.json();
        const match = messages.find((m) => subject.test(m.Subject));
        if (!match) return null;
        const full = await (await fetch(`${MAILPIT_URL}/api/v1/message/${match.ID}`)).json();
        found = { subject: match.Subject, text: full.Text };
        return match.ID;
      },
      { message: `an email to ${to} matching ${subject}`, timeout },
    )
    .not.toBeNull();
  return found;
}
/** The first link in an email that points at the app. */
export const appLink = (text) => {
  const link = (text.match(/https?:\/\/\S+/g) || []).find((url) => url.startsWith(WEB_URL));
  if (!link) throw new Error(`no app link in: ${text}`);
  return link;
};

// ---- the agent protocol, spoken directly -----------------------------------------------------
export const fingerprint = (seed) => createHash('sha256').update(String(seed)).digest('hex');
const post = async (path, token, body) => {
  const response = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
export const registerAgent = (key, name, seed = name, extra = {}) =>
  post('/v1/register', key, {
    name,
    fingerprint: fingerprint(seed),
    platform: 'linux',
    os: 'Ubuntu 24.04',
    arch: 'amd64',
    version: '0.1.0',
    ...extra,
  });
export const sampleBody = (cpu = 20, errors = []) => ({
  sentAt: new Date().toISOString(),
  agent: { version: '0.1.0', os: 'Ubuntu 24.04', arch: 'amd64', cores: 4, ramBytes: 8 * 1024 ** 3 },
  samples: [
    {
      time: new Date().toISOString(),
      cpu,
      memory: 40,
      swap: 1,
      disk: 55,
      load: [0.4, 0.3, 0.2],
      netRxBps: 2000,
      netTxBps: 1000,
      diskReadBps: 100,
      diskWriteBps: 200,
      uptimeSeconds: 5000,
      details: { mounts: [{ path: '/', percent: 55, totalBytes: 1e11, usedBytes: 5.5e10 }] },
    },
  ],
  errors,
});
export const ingest = (credential, body = sampleBody()) => post('/v1/ingest', credential, body);

/** Eight days of one-minute samples, then rebuild the 5-minute and 1-hour rollups. */
export async function seedHistory(agentId, orgId, days = 8) {
  const prisma = db();
  await prisma.$executeRawUnsafe(
    `INSERT INTO server_metrics (time, agent_id, org_id, cpu_percent, mem_percent, swap_percent, disk_percent,
       load1, load5, load15, net_rx_bps, net_tx_bps, disk_read_bps, disk_write_bps, uptime_seconds)
     SELECT t, $1, $2, 25 + 15 * sin(extract(epoch FROM t) / 3600), 45 + 5 * sin(extract(epoch FROM t) / 900), 1, 60,
       0.5, 0.4, 0.3, 1000 + 500 * sin(extract(epoch FROM t) / 600), 500, 10, 20, 1000
     FROM generate_series(now() - make_interval(days => $3::int), now() - interval '5 minutes',
       make_interval(secs => 60)) AS t ON CONFLICT DO NOTHING`,
    agentId,
    orgId,
    days,
  );
  for (const view of ['server_metrics_5m', 'server_metrics_1h'])
    await prisma.$executeRawUnsafe(
      `CALL refresh_continuous_aggregate('${view}', now() - interval '40 days', now() - interval '2 hours')`,
    );
}
