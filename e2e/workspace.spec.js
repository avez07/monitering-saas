import { test, expect } from '@playwright/test';
import { config } from '../backend/src/config.js';

async function demoLogin(page) {
  await page.goto('/');
  await page.getByRole('button', { name: /Explore the demo workspace/ }).click();
  await expect(page.getByRole('heading', { name: 'Workspace overview' })).toBeVisible();
}
test('demo dashboard and all fourteen monitoring pages load', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await demoLogin(page);
  await expect(page.getByText('production-api-01', { exact: true })).toBeVisible();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: 'docs/verification/dashboard.png', fullPage: true });
  for (const [link, title] of [
    ['Infrastructure', 'Infrastructure'],
    ['Servers', 'Servers'],
    ['Containers', 'Containers'],
    ['Applications', 'Applications'],
    ['Logs explorer', 'Logs explorer'],
    ['Trace explorer', 'Trace explorer'],
    ['Databases', 'Databases'],
    ['Uptime', 'Uptime monitoring'],
    ['Alerts', 'Alerts'],
    ['Agents', 'Agent management'],
    ['Team & access', 'Team & access'],
    ['Billing & usage', 'Billing & usage'],
    ['Settings', 'Settings'],
  ]) {
    await page.locator('nav').getByRole('link', { name: link, exact: true }).click();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(page.getByText('We couldn’t load this data')).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});
test('searches, trace details, and enrollment wizard work', async ({ page }) => {
  await demoLogin(page);
  await page.locator('nav').getByRole('link', { name: 'Servers', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search resources…', exact: true }).fill('worker-01');
  await expect(page.getByText('production-worker-01', { exact: true })).toBeVisible();
  await expect(page.getByText('production-api-01', { exact: true })).toHaveCount(0);
  await page.locator('nav').getByRole('link', { name: 'Trace explorer', exact: true }).click();
  await page.locator('tbody tr').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('HTTP request', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.locator('nav').getByRole('link', { name: 'Agents', exact: true }).click();
  await page.getByRole('button', { name: 'Connect agent', exact: true }).click();
  await page.getByRole('button', { name: 'Generate installation token' }).click();
  await expect(page.getByText('TERMINAL · NODE.JS 22+')).toBeVisible();
  await expect(page.locator('.code-block pre')).toContainText(
    'node backend/scripts/agent.mjs --enroll',
  );
});
test('registration creates an empty isolated workspace and project changes persist', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name', exact: true }).fill('Browser Test Owner');
  await page
    .getByRole('textbox', { name: 'Organization', exact: true })
    .fill('Browser Test Workspace');
  await page
    .getByRole('textbox', { name: 'Email address', exact: true })
    .fill(`browser-${Date.now()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(config.DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Workspace overview' })).toBeVisible();
  await expect(page.getByText('Your workspace is ready to connect.')).toBeVisible();
  await page.locator('nav').getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Projects & environments' }).click();
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Project name', exact: true })
    .fill('Browser Created Project');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Browser Created Project', { exact: true }).first()).toBeAttached();
  await page.reload();
  await page.getByRole('tab', { name: 'Projects & environments' }).click();
  await expect(page.getByText('Browser Created Project', { exact: true }).first()).toBeAttached();
});
test('mobile navigation is usable without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await demoLogin(page);
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.locator('nav').getByRole('link', { name: 'Servers', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Servers', exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
  await page.screenshot({ path: 'docs/verification/mobile.png', fullPage: true });
});
