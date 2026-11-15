import { defineConfig } from '@playwright/test';
import { API_PORT, API_URL, WEB_PORT, WEB_URL } from './e2e/env.mjs';

// Needs Docker services running (`docker compose up -d postgres mailpit`) and Google Chrome (or set
// E2E_CHANNEL= to use Playwright's own Chromium after `npx playwright install chromium`).
const channel = process.env.E2E_CHANNEL ?? 'chrome';
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: { timeout: 10000 },
  reporter: 'list',
  use: {
    baseURL: WEB_URL,
    ...(channel ? { channel } : {}),
    headless: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node e2e/stack.mjs',
      url: `${API_URL}/api/health`,
      timeout: 120000,
      reuseExistingServer: true,
      env: { E2E_API_PORT: String(API_PORT), E2E_WEB_PORT: String(WEB_PORT) },
    },
    {
      command: 'npm run dev -w frontend',
      url: WEB_URL,
      timeout: 120000,
      reuseExistingServer: true,
      env: { API_PORT: String(API_PORT), FRONTEND_PORT: String(WEB_PORT) },
    },
  ],
});
