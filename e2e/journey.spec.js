import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { API_URL, WEB_URL } from './env.mjs';
import {
  PASSWORD,
  appLink,
  closeDb,
  db,
  emailFor,
  ingest,
  registerAgent,
  sampleBody,
  seedHistory,
  signUp,
  unique,
  waitForMail,
} from './helpers.js';

// One customer's first day, start to finish, in a real browser against the real API and worker.
// The steps share state (the account, the server) and run in order.
test.describe.configure({ mode: 'serial' });

const owner = { name: 'Priya Owner', org: unique('Acme'), email: emailFor('owner') };
const invitee = { name: 'Vikram Viewer', email: emailFor('viewer') };
const state = {};
let agentProcess;
let agentDir;
let fakeSite;
let browserRef;
let context;
let page; // one signed-in browser tab for the whole journey

test.beforeAll(async ({ browser }) => {
  browserRef = browser;
  context = await browser.newContext({
    baseURL: WEB_URL,
    viewport: { width: 1440, height: 1000 },
  });
  page = await context.newPage();
  // A tiny website for the monitor to check (the API allows loopback targets only when started for tests).
  fakeSite = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('hello from the fake site');
  });
  await new Promise((resolve) => fakeSite.listen(0, '127.0.0.1', resolve));
  state.siteUrl = `http://127.0.0.1:${fakeSite.address().port}/`;
});
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus)
    await info.attach('screenshot', { body: await page.screenshot(), contentType: 'image/png' });
});
test.afterAll(async () => {
  await context?.close();
  agentProcess?.kill();
  fakeSite?.close();
  if (agentDir) rmSync(agentDir, { recursive: true, force: true });
  await closeDb();
});

test('sign up lands on an empty Overview that points to the first server, with an unverified-email banner', async () => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signUp(page, owner);
  await expect(
    page.getByRole('heading', { name: "Let's get your first server connected" }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add your first server' })).toBeVisible();
  await expect(page.getByTestId('verify-banner')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the banner resends the verification email and the emailed link verifies the account', async () => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Resend email' }).click();
  await expect(page.getByText('Verification email sent.')).toBeVisible();
  const mail = await waitForMail(owner.email, /confirm|verify/i);
  await page.goto(appLink(mail.text));
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  await expect(page.getByTestId('verify-banner')).toHaveCount(0);
});

test('the Add server wizard creates the API key and a copyable install command', async () => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByRole('link', { name: 'Add your first server' }).click();
  await expect(page.getByText('Step 1 of 5')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click(); // where it runs (default Ubuntu)
  await expect(page.getByText('Step 2 of 5')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click(); // what to monitor
  await expect(page.getByText('Step 3 of 5')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click(); // review and save the setup profile
  await expect(page.getByText('Step 4 of 5')).toBeVisible();

  await page.getByRole('button', { name: 'Create API key' }).click();
  await expect(page.getByText('Your API key (shown only once)')).toBeVisible();
  const command = page.getByLabel('install command', { exact: true });
  await expect(command).toContainText('yk_live_');
  const text = await command.innerText();
  state.key = text.match(/yk_live_[A-Za-z0-9_-]+/)[0];
  state.setupId = text.match(/st_[a-f0-9]{24}/)?.[0];

  await page.getByRole('button', { name: 'Copy install command' }).click();
  await expect(page.getByRole('button', { name: 'Copy install command' })).toContainText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
});

test('the development agent connects and the wizard shows Connected', async () => {
  agentDir = mkdtempSync(join(tmpdir(), 'yuktiops-e2e-agent-'));
  const args = ['backend/scripts/agent.mjs', '--register', '--key', state.key, '--api', API_URL];
  if (state.setupId) args.push('--setup', state.setupId);
  await page.goto('/add-server');
  // The wizard keeps nothing across reloads, so walk to the install step again and wait there.
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('textbox', { name: 'Your API key' }).fill(state.key);
  await page.getByRole('button', { name: 'I ran the command' }).click();
  await expect(page.getByText('Step 5 of 5')).toBeVisible();
  // Run the command from the install step: registers this machine and starts sending.
  agentProcess = spawn(process.execPath, args, {
    env: {
      ...process.env,
      YUKTIOPS_CONFIG_DIR: agentDir,
      YUKTIOPS_SEND_SECONDS: '15',
      YUKTIOPS_SAMPLE_SECONDS: '5',
    },
    stdio: 'ignore',
  });
  await expect(page.getByText('Connected!')).toBeVisible({ timeout: 60000 });
  await page.getByRole('link', { name: 'Open your server' }).click();
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]{36}/);
  state.agentId = page.url().match(/servers\/([0-9a-f-]{36})/)[1];
});

test('the server page draws charts for all four time ranges', async () => {
  const agent = await db().agent.findUnique({ where: { id: state.agentId } });
  state.orgId = agent.orgId;
  await seedHistory(agent.id, agent.orgId);
  await page.goto(`/servers/${state.agentId}`);
  const cpu = page.getByRole('img', { name: /Chart of CPU/ });
  await expect(cpu).toBeVisible();
  for (const range of ['1 hour', '24 hours', '7 days', '30 days']) {
    await page.getByRole('button', { name: range, exact: true }).click();
    await expect(page.getByRole('button', { name: range, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(cpu.locator('.recharts-area-area, .recharts-line-curve').first()).toBeVisible();
    await expect(page.getByText('No data in this time range yet.')).toHaveCount(0);
  }
});

test('the Connection tab explains each state: connected, waiting, problem and silent', async () => {
  // Connected: the agent is sending.
  await page.goto(`/servers/${state.agentId}/connection`);
  await expect(page.getByRole('heading', { name: 'Connected', exact: true })).toBeVisible();

  // A second server that has registered but not sent anything yet.
  const second = await registerAgent(state.key, 'second-host');
  expect(second.status).toBe(201);
  state.secondId = second.body.agentId;
  await page.goto(`/servers/${state.secondId}/connection`);
  await expect(page.getByRole('heading', { name: 'Waiting for the agent' })).toBeVisible();

  // It reports a Docker permission problem together with data.
  const sent = await ingest(
    second.body.credential,
    sampleBody(30, [{ code: 'docker_socket_denied', message: 'permission denied' }]),
  );
  expect(sent.status).toBe(202);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'There is a problem' })).toBeVisible();
  await expect(page.getByText('Problems to fix')).toBeVisible();

  // Then it goes quiet: age everything it ever said.
  await db().agentEvent.deleteMany({ where: { agentId: state.secondId } });
  await db().agent.update({
    where: { id: state.secondId },
    data: { lastSeen: new Date(Date.now() - 3600000), status: 'healthy' },
  });
  await db().$executeRaw`DELETE FROM server_metrics WHERE agent_id = ${state.secondId}`;
  await page.reload();
  await expect(page.getByRole('heading', { name: "We can't hear from this server" })).toBeVisible();
});

test('an alert is created from a template and an email contact receives its test message', async () => {
  await page.goto('/alerts');
  await page.getByRole('button', { name: 'Add from template' }).first().click();
  const card = page
    .getByRole('dialog')
    .locator('li button')
    .filter({ hasNotText: 'Already added' })
    .first();
  const name = (await card.locator('span').first().innerText()).trim();
  await card.click();
  await expect(page.getByText(/added\. You can change anything below/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText(name).first()).toBeVisible();

  state.contactEmail = emailFor('oncall');
  await page.getByRole('tab', { name: 'Where to send alerts' }).click();
  await page.getByRole('button', { name: 'Add a contact' }).first().click();
  await page.getByRole('button', { name: /^Email/ }).click();
  await page.getByLabel('Email address').fill(state.contactEmail);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^(Add|Save|Create)/ })
    .last()
    .click();
  await expect(page.getByText('Contact added.')).toBeVisible();
  const row = page.getByRole('listitem').filter({ hasText: state.contactEmail });
  await row.getByRole('button', { name: /Send test/ }).click();
  await expect(page.getByText('The test message was delivered.')).toBeVisible();
  const mail = await waitForMail(state.contactEmail, /test/i);
  expect(mail.text.length).toBeGreaterThan(10);
});

test('a website is added and the worker reports it up', async () => {
  await page.goto('/websites');
  await page
    .getByRole('button', { name: /Add (your first )?website/ })
    .first()
    .click();
  await page.getByLabel('Address').fill(state.siteUrl);
  await page.getByLabel('Name').fill('Fake shop');
  await page.getByRole('button', { name: 'Add and start checking' }).click();
  await expect(page.getByText('Fake shop').first()).toBeVisible();
  await expect(page.getByText('Up', { exact: true }).first()).toBeVisible({ timeout: 45000 });
});

test('the owner invites a viewer; the invitee accepts by email link and cannot change anything', async () => {
  // The Free plan has one seat; moving to Starter is a billing matter, so do it in the database.
  await db().subscription.updateMany({
    where: { orgId: state.orgId },
    data: { planId: 'starter' },
  });
  await page.goto('/settings/team');
  await page.getByLabel('Email address').fill(invitee.email);
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByText('Invitation sent.').first()).toBeVisible();
  const mail = await waitForMail(invitee.email, /invited you/i);
  const link = appLink(mail.text);

  state.inviteContext = await browserRef.newContext({ baseURL: WEB_URL });
  const guest = await state.inviteContext.newPage();
  await guest.goto(link);
  await guest.getByLabel('Your name').fill(invitee.name);
  await guest.getByLabel('Choose a password').fill(PASSWORD);
  await guest.getByRole('button', { name: 'Create account and join' }).click();
  await expect(guest.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible({
    timeout: 20000,
  });
  state.guest = guest;

  await guest.goto('/alerts');
  await expect(guest.getByRole('heading', { name: 'Alerts', exact: true })).toBeVisible();
  await expect(guest.getByRole('button', { name: 'Add from template' })).toHaveCount(0);
  await guest.goto('/websites');
  await expect(guest.getByText('Fake shop').first()).toBeVisible();
  await expect(guest.getByRole('button', { name: /Add (your first )?website/ })).toHaveCount(0);
  await guest.goto('/settings/team');
  await expect(guest.getByText(/Only owners and admins can see and manage the team/)).toBeVisible();
  // And the API agrees: writes are refused.
  const refused = await state.inviteContext.request.post('/api/websites', {
    headers: { Origin: WEB_URL },
    data: { type: 'http', url: state.siteUrl, name: 'Nope' },
  });
  expect(refused.status()).toBe(403);
});

test('removing the member ends their access straight away', async () => {
  await page.goto('/settings/team');
  await page.getByRole('button', { name: `Remove ${invitee.name}` }).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByText('Member removed.')).toBeVisible();

  const gone = await state.inviteContext.request.get('/api/servers');
  expect(gone.status()).toBe(403);
  await state.guest.reload();
  await expect(state.guest.getByRole('heading', { name: 'Overview', exact: true })).toHaveCount(0);
  await expect(
    state.guest.getByText(/couldn.t load your account|not have access/i).first(),
  ).toBeVisible();
  await state.inviteContext.close();
});

test('regenerating the API key makes the old one stop working', async () => {
  await page.goto('/settings/api-key');
  await expect(page.getByText('Account API key')).toBeVisible();
  await page.getByRole('button', { name: 'Regenerate key' }).click();
  await page.getByRole('button', { name: 'Regenerate', exact: true }).click();
  await expect(page.getByText('Copy your new API key now')).toBeVisible();
  const fresh = await page.locator('code').filter({ hasText: 'yk_live_' }).first().innerText();
  expect(fresh).not.toBe(state.key);
  expect((await registerAgent(state.key, 'late-host')).status).toBe(401);
  expect((await registerAgent(fresh, 'late-host')).status).toBe(201); // the new key works
});

test('theme toggle, 375px mobile navigation and sign out', async () => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Change theme' }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Change theme' }).click();
  await page.getByRole('menuitemradio', { name: 'Light' }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);

  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Alerts' })
    .click();
  await expect(page).toHaveURL(/\/alerts/);
  await expect(page.getByRole('heading', { name: 'Alerts', exact: true })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await page.getByRole('button', { name: /account menu/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await page.goto('/servers');
  await expect(page).toHaveURL(/\/login/);
});
