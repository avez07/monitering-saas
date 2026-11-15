import { createServer } from 'node:http';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { WEB_URL } from './env.mjs';
import {
  closeDb,
  emailFor,
  ingest,
  registerAgent,
  sampleBody,
  seedHistory,
  db,
  signUp,
  unique,
} from './helpers.js';

// Accessibility (WCAG 2.1 A/AA) on every main page, in light and dark.
test.describe.configure({ mode: 'serial' });

const owner = { name: 'Axe Owner', org: unique('Axe'), email: emailFor('axe') };
const ids = {};
let fakeSite;

const guestPages = [
  ['login', '/login'],
  ['register', '/register'],
  ['forgot password', '/forgot-password'],
  ['invalid invite', '/invite/not-a-real-token'],
];
const appPages = () => [
  ['overview', '/'],
  ['servers', '/servers'],
  ['server overview', `/servers/${ids.agent}`],
  ['server connection', `/servers/${ids.agent}/connection`],
  ['server settings', `/servers/${ids.agent}/settings`],
  ['containers', '/containers'],
  ['services', '/services'],
  ['websites', '/websites'],
  ['website detail', `/websites/${ids.site}`],
  ['alerts rules', '/alerts'],
  ['alerts history', '/alerts/history'],
  ['alerts contacts', '/alerts/contacts'],
  ['settings team', '/settings/team'],
  ['settings api key', '/settings/api-key'],
  ['settings plan', '/settings/plan'],
  ['settings account', '/settings/account'],
  ['add server', '/add-server'],
];

async function scan(page, url, label, theme) {
  await page.goto(url);
  await expect(page.getByRole('heading').first()).toBeVisible();
  await page.waitForTimeout(1500); // let skeletons finish and chart animations settle
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const summary = violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n   ${v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(' '))
        .join('\n   ')}`,
  );
  expect(summary, `${label} [${theme}] accessibility violations`).toEqual([]);
}

test.beforeAll(async () => {
  fakeSite = createServer((request, response) => response.end('ok'));
  await new Promise((resolve) => fakeSite.listen(0, '127.0.0.1', resolve));
});
test.afterAll(async () => {
  fakeSite?.close();
  await closeDb();
});

for (const theme of ['light', 'dark']) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme: theme });
    test.beforeEach(async ({ context }) => {
      await context.addInitScript((value) => {
        try {
          localStorage.setItem('yuktiops.theme', value);
        } catch {
          /* ignore */
        }
      }, theme);
    });

    for (const [label, url] of guestPages)
      test(`signed out: ${label}`, async ({ page }) => scan(page, url, label, theme));

    test('signed in: every main page', async ({ page }) => {
      test.setTimeout(240000);
      if (theme === 'light') {
        await signUp(page, owner);
        const headers = { Origin: WEB_URL };
        const key = (await (await page.request.post('/api/api-key', { headers })).json()).key;
        const server = await registerAgent(key, 'axe-host');
        await ingest(server.body.credential, sampleBody(35));
        ids.agent = server.body.agentId;
        const agent = await db().agent.findUnique({ where: { id: ids.agent } });
        await seedHistory(agent.id, agent.orgId, 2);
        const site = await page.request.post('/api/websites', {
          headers,
          data: {
            type: 'http',
            url: `http://127.0.0.1:${fakeSite.address().port}/`,
            name: 'Axe site',
          },
        });
        ids.site = (await site.json()).id;
        ids.session = await page.context().storageState();
      } else {
        await page.context().addCookies(ids.session.cookies);
      }
      for (const [label, url] of appPages()) await scan(page, url, label, theme);
    });
  });
}
