# YuktiOps marketing site and docs

Astro (static) + Tailwind CSS v3 (PostCSS). No TypeScript. Near-zero client JS: `public/theme.js` (no-flash dark mode) and `public/toggles.js` (theme, currency, mobile menu).

```
npm run site:dev      # from the repo root (or: npm run dev -w site)
npm run site:build    # output in site/dist
```

## Theme

All colours, radius, fonts and shadows are CSS variables. **Both `site/src/styles/index.css` and `frontend/src/index.css` hold the same `:root` and `.dark` blocks.** Paste your tweakcn (Tailwind v3) export over those two blocks in BOTH files and both the app and the site restyle. `tailwind.config.js` is the same mapping as the app's. Never use colour literals, `@import "tailwindcss"`, `@theme` or `tw-animate-css`.

## Configuration (env, see `.env.example`)

`PUBLIC_APP_URL` (sign-up links, default https://app.yuktiops.com), `PUBLIC_SITE_URL` (canonical, sitemap), `PUBLIC_CONTACT_EMAIL`. Also update the sitemap line in `public/robots.txt` if the domain changes.

## Content

- Pricing data: `src/site.js` (from PLAN.md section 5). Confirm before launch.
- Docs: Markdown files in `src/content/docs/` (front matter: title, description, group, order). Sidebar is generated.
- Legal pages (`privacy`, `terms`, `refunds`) are DRAFTS marked as such; a lawyer must review them.
