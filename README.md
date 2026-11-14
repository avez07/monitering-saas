# YuktiOps

Simple, affordable server monitoring for startups and mid-size companies on a VPS or shared hosting. A one-command agent for servers, agentless checks for websites, and a dashboard with alerts. Use it as your main monitoring or as an independent second opinion next to another tool.

**Start here: [START.md](START.md)** (run it, test it). **Roadmap: [PLAN.md](PLAN.md).**

```
frontend/          React, Vite, Tailwind, TanStack Query (the dashboard)
backend/src/       Express API, services, the background worker, Prisma repository
backend/prisma/    Schema and migrations (PostgreSQL + TimescaleDB image)
backend/scripts/   Development agent, Prisma runner, test-database setup
backend/test/      Integration tests (run against a real PostgreSQL)
e2e/               Browser tests (Playwright)
```

## Status

Phases 0 (cleanup and security baseline) and 1 (account API key, registration and metric storage) are done. The Go agent and installer, the redesigned dashboard with the "Add server" wizard, simple alerts, team invites and website checks are the next phases in [PLAN.md](PLAN.md).

Today: sign up, one account API key that registers any number of servers (each server then gets its own revocable credential), a gzip JSON ingest protocol at `/v1`, 30-second metric history in a TimescaleDB hypertable with 5-minute and 1-hour rollups, a development agent (Node script) that speaks the real protocol, alert rules with email notifications, website uptime checks, plan limits, and a mock billing flow.

## Security basics

- Sessions are random tokens in an httpOnly, SameSite cookie; only a hash is stored, and sessions can be revoked (logout, logout everywhere).
- State-changing browser requests must come from the dashboard origin (CSRF protection).
- Login is rate limited per IP and per account; `TRUST_PROXY` must match your reverse proxy.
- Strict security headers (CSP, HSTS in production). Production refuses http URLs and placeholder secrets.
- The agent refuses to send credentials over plain http (except to localhost).
- The account API key is shown once and stored only as a hash. The agent uses it once to register and never saves it; it keeps only its own per-server credential, which can be revoked on its own.
- Agent requests are size-limited after decompression, and repeated wrong API keys from one address are throttled.
