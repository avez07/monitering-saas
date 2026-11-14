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

Phase 0 (cleanup and security baseline) is done. The production Go agent, metric history and charts, more alert channels, agentless website checks and billing are the next phases in [PLAN.md](PLAN.md).

Today: sign up, projects, per-server agent credentials (one-time enrollment token, hashed storage, rotate and revoke), a development agent that reports CPU, memory, disk and uptime, alert rules with email notifications, website uptime checks, plan limits, and a mock billing flow.

## Security basics

- Sessions are random tokens in an httpOnly, SameSite cookie; only a hash is stored, and sessions can be revoked (logout, logout everywhere).
- State-changing browser requests must come from the dashboard origin (CSRF protection).
- Login is rate limited per IP and per account; `TRUST_PROXY` must match your reverse proxy.
- Strict security headers (CSP, HSTS in production). Production refuses http URLs and placeholder secrets.
- The agent refuses to send credentials over plain http (except to localhost).
