# Pulse monitoring

A local-first monitoring SaaS starter with a custom React dashboard, a modular Express API, project-scoped agent credentials, PostgreSQL metadata, and OTLP ingestion adapters for Mimir, Loki, and Tempo.

**Start here: [START.md](START.md).** All development service credentials are in the root `.env`. `.env.example` is the safe template. The frontend receives no infrastructure secrets.

```
frontend/          React, Vite, Tailwind, TanStack Query, shared UI components
backend/src/       API routes, centralized config, repositories, monitoring services
backend/prisma/    Normalized schema, initial SQL migration, plan/demo seed
backend/scripts/   Host agent, Prisma runner, ten-tenant API load test
backend/test/      Integration and tenant-isolation tests
infra/             Telemetry storage configs, internal Grafana, service templates
e2e/               Browser workflow tests
docs/              Architecture, API, capacity model, operations, scope
```

Demo mode uses persistent JSON metadata and explicitly labeled sample telemetry. Connected mode uses PostgreSQL, Redis, and real telemetry storage. Switching modes does not migrate demo metadata.

This is an implemented development MVP, not a production certification or a finished enterprise platform. Read [the implementation status](docs/STATUS.md) before planning a paid rollout.

Documentation: [architecture and ERD](docs/ARCHITECTURE.md), [API contract](docs/API.md), [collector and SDK setup](docs/AGENTS.md), [capacity model](docs/CAPACITY.md), [operations](docs/OPERATIONS.md), [roadmap](docs/ROADMAP.md).
