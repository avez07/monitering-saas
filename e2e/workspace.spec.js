import { test, expect } from '@playwright/test';

// One account for the whole file: registration is rate limited per IP, as it should be.
const email = `e2e-${Date.now()}@example.com`;
const password = 'correct-horse-battery';

async function signIn(page) {
  await page.goto('/');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /Sign in/ }).click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('a new customer registers and every page loads, with the session kept out of page storage', async ({
  page,
  context,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  // There is no demo shortcut any more.
  await expect(page.getByText(/demo/i)).toHaveCount(0);
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Your name').fill('E2E Owner');
  await page.getByLabel('Organization').fill('E2E Company');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /Create workspace/ }).click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  await expect(page.getByText('Free plan')).toBeVisible();

  // The session is an httpOnly cookie: scripts and storage must not see it.
  const cookie = (await context.cookies()).find((c) => c.name === 'yuktiops_session');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Lax');
  expect(await page.evaluate(() => document.cookie)).not.toContain('yuktiops_session');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toMatch(/token|ses_/i);

  for (const [link, title] of [
    ['Servers', 'Servers'],
    ['Websites', 'Uptime monitoring'],
    ['Alerts', 'Alerts'],
    ['Agents', 'Agent management'],
    ['Team & access', 'Team & access'],
    ['Plan & billing', 'Billing & usage'],
    ['Settings', 'Settings'],
  ]) {
    await page.locator('nav').getByRole('link', { name: link, exact: true }).click();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(page.getByText('We couldn’t load this data')).toHaveCount(0);
  }
  // Removed product areas are gone from the navigation.
  for (const gone of ['Containers', 'Applications', 'Logs explorer', 'Trace explorer', 'Databases'])
    await expect(page.locator('nav').getByRole('link', { name: gone })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('connecting a server creates the one account API key and builds the install command', async ({
  page,
}) => {
  await signIn(page);
  await page.locator('nav').getByRole('link', { name: 'Servers', exact: true }).click();
  await page.getByRole('button', { name: 'Connect a server' }).first().click();
  await page.getByRole('button', { name: 'Create API key' }).click();
  await expect(page.locator('pre')).toContainText(/--register --key yk_live_[a-f0-9]{64} --api /);
  // The raw key is never kept in browser storage.
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
  ).not.toMatch(/yk_live_/);
  // Opening the dialog again shows only a prefix and offers to regenerate; it cannot show the key.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Connect a server' }).first().click();
  await expect(page.getByText(/Your API key \(yk_live_[a-f0-9]{4}…\)/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lost it? Regenerate' })).toBeVisible();
});

test('signing out ends the session on the server, not just in the browser', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await signIn(page);
});

test('mobile navigation opens and reaches a page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.locator('nav').getByRole('link', { name: 'Servers', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Servers', exact: true })).toBeVisible();
});
