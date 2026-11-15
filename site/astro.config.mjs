import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

const site = process.env.PUBLIC_SITE_URL || 'https://yuktiops.com';

export default defineConfig({
  site,
  trailingSlash: 'never',
  build: { format: 'file' },
  markdown: { syntaxHighlight: false },
  integrations: [sitemap()],
});
