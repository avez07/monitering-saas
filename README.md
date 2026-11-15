# YuktiOps

Simple, affordable server monitoring for startups and mid-size companies on a VPS or shared hosting. A one-command agent for servers, agentless checks for websites, and a dashboard with alerts. Use it as your main monitoring or as an independent second opinion next to another tool.

**Start here: [START.md](START.md)** (run it, test it). **Roadmap: [PLAN.md](PLAN.md).**

```
frontend/          React 18, Vite, Tailwind v3, shadcn/ui, TanStack Query (the dashboard)
backend/src/       Express API, services, the background worker, Prisma repository
backend/prisma/    Schema and migrations (PostgreSQL + TimescaleDB image)
backend/scripts/   Development agent, Prisma runner, test-database setup
backend/test/      Integration tests (run against a real PostgreSQL)
agent/             The Go agent, installer (install.sh) and packaging (.deb, .rpm, Docker)
site/              Marketing site, docs and troubleshooting pages (Astro)
e2e/               Browser tests (Playwright + axe accessibility checks)
deploy/            Production compose, Caddy, backups, load test
docs/              API notes, runbook, billing and ops guides
```

## Status

All build phases are in place: accounts and teams (owner, admin, viewer), the account API key and per-server credentials, the Go agent with a one-command installer, the dashboard (Overview, Servers with 1h/24h/7d/30d charts and a Connection page, Add-server wizard, Containers, Services, Websites and APIs, Alerts with templates and contacts, Settings), email verification and invites, billing (mock provider locally), and the marketing site. See [PLAN.md](PLAN.md) for the roadmap and [START.md](START.md) to run and test everything.

## Security basics

- Sessions are random tokens in an httpOnly, SameSite cookie; only a hash is stored, and sessions can be revoked (logout, logout everywhere).
- State-changing browser requests must come from the dashboard origin (CSRF protection).
- Login is rate limited per IP and per account; `TRUST_PROXY` must match your reverse proxy.
- Strict security headers (CSP, HSTS in production). Production refuses http URLs and placeholder secrets.
- The agent refuses to send credentials over plain http (except to localhost).
- The account API key is shown once and stored only as a hash. The agent uses it once to register and never saves it; it keeps only its own per-server credential, which can be revoked on its own.
- Agent requests are size-limited after decompression, and repeated wrong API keys from one address are throttled.
