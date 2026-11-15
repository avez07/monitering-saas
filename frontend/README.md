# YuktiOps frontend

## Stack rules (fixed)

- React with **JSX only** (`.jsx`, `.js`). No TypeScript.
- Vite. `@` is an alias for `src/` (vite.config.js and jsconfig.json).
- **Tailwind CSS v3.4** with `tailwind.config.js`, `postcss.config.js`, `tailwindcss-animate`.
  Forbidden anywhere: `@import "tailwindcss"`, `@theme`, `@tailwindcss/vite`, `tw-animate-css`,
  `@plugin`, `@custom-variant`. Use `@tailwind base/components/utilities` only.
- **shadcn/ui** through the v3-compatible CLI only: `shadcn@2.3.0` (never `@latest`).
- React Query, React Router v7, Recharts, lucide-react.

## Theme rules

- All colours, radius, fonts and shadows are CSS variables in `src/index.css` (`:root` and `.dark`),
  as bare HSL triplets (the tweakcn Tailwind v3 format). `tailwind.config.js` maps them
  (`hsl(var(--primary))`, `rounded-lg` = `--radius`, `font-sans`, `shadow-md`, ...).
- The values currently there are the stock shadcn "neutral" PLACEHOLDER. To apply your own theme,
  paste a tweakcn export over the `:root` and `.dark` blocks.
- **Never hard-code colours** (no hex, no `text-red-500`). Use tokens: `bg-background`, `text-foreground`,
  `text-muted-foreground`, `bg-card`, `border`, `bg-primary`, `text-destructive`, `bg-chart-1..5`, `bg-sidebar`.
- Status uses `chart-2` (Healthy), `chart-4` (Needs attention), `destructive` (Down), `muted-foreground`
  (Waiting for data), always with a word. See `src/lib/status.js` and `StatusBadge`. No extra success/warning variables.
- Dark mode: `.dark` on `<html>`; `ThemeProvider` / `useTheme()` in `src/lib/theme.jsx`;
  `public/theme.js` prevents a flash (kept external because of the CSP).

## Adding a shadcn component

```
cd frontend
printf '\r\r\r' | npx shadcn@2.3.0 add -y -o <name>
```

The piped Enter answers the React 19 "Use --force" prompt. Files land in `src/components/ui/`.
Do not edit them for styling; change the theme variables instead. `sonner.jsx` uses our own `useTheme`.

## Folder ownership

| Folder                          | Owner                                                      |
| ------------------------------- | ---------------------------------------------------------- |
| `src/routes.jsx`, `src/main.jsx`, `src/lib/*`, `src/components/{ui,app,shell}` | foundation (ask before changing; additive changes OK) |
| `src/pages/auth`                | auth (Login, Register done; forgot/reset/verify/invite are stubs) |
| `src/pages/overview`            | overview                                                   |
| `src/pages/servers`             | servers (`/servers/*`: list and `:id` detail, own nested routes) |
| `src/pages/containers`, `services` | respective owner                                        |
| `src/pages/websites`, `alerts`, `settings` | own nested routes under `/websites/*`, `/alerts/*`, `/settings/*` (settings: team, api-key, plan, account) |
| `src/pages/add-server`          | add-server wizard                                          |

Every page folder has `index.jsx` with a `default` export. Pages render inside `AppShell`
(sidebar, top bar). Do not render your own sidebar or top bar.

## Shared libraries (`src/lib`)

- `api.js`: `api(path, { method, body, params })` (cookie session, `/api` prefix, throws `Error` with `.status`).
- `hooks.js`: `useApi(path, params, options)` (query), `useAction()` (mutation, refreshes everything, toasts).
- `session.jsx`: `useSession()` gives `{ user, organization, organizations, role, plan, subscription, canEdit, isAdmin, signOut, ... }`.
- `format.js`: `formatBytes, formatPercent, formatNumber, formatDuration, formatMs, formatRelative, formatDateTime`.
- `status.js`: `statusInfo, usageLevel, STATUS`. `utils.js`: `cn`. `use-media-query.js`.

## Shared components (`import { ... } from '@/components/app'`)

`PageHeader` (title, description, breadcrumbs, actions), `StatusBadge`, `StatCard`, `MetricBar`,
`EmptyState` (one action), `ErrorState`, `LoadingState`, `CardSkeleton`, `StatGridSkeleton`, `TableSkeleton`,
`ConfirmDialog`, `CopyField`, `CodeBlock`, `RelativeTime`, `DataTable`, `ChartCard`, `TimeSeriesChart`,
`FormField`, `notify`, `ComingSoon`.

## Scripts

`npm run dev -w frontend` (port 5173, proxies `/api`, `/v1`, `/downloads` to `http://127.0.0.1:${API_PORT || PORT || 4000}`),
`npm run build -w frontend`, `npm run preview -w frontend`.
