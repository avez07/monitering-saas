# Operations and deployment runbook

## Configuration

`backend/src/config.js` is the single application configuration reader. It loads root `.env`, validates fields, and exports typed settings. Docker Compose reads the same `.env`; its app profile overrides only container-specific endpoints. Browser configuration contains no service credentials.

Use `DEMO_MODE=true` only for local evaluation. Production mode requires `DEMO_MODE=false` and a non-dummy JWT secret. This guard prevents accidental public demo access; it does not replace an operational configuration review. The included Docker profile intentionally runs in development mode with dummy credentials. For remote hosting, replace those values, configure TLS at a reverse proxy, set APP_URL/API_PUBLIC_URL, remove telemetry/database/Redis/object-storage public mappings, and set NODE_ENV=production. Retain only the externally needed app/ingestion endpoint.

## Startup and health

1. Back up PostgreSQL and object storage before upgrades.
2. Start storage and Redis.
3. Apply committed SQL migrations with `npm run db:migrate`.
4. Generate Prisma client on builds with `npm run db:generate`.
5. Start the API; it seeds missing plan definitions without changing existing subscriptions.
6. Verify `/api/health`, register/login, agent heartbeat, each signal's authenticated write, and project-scoped query.

Health currently checks metadata and Redis. Telemetry backend readiness is surfaced by ingestion/query errors, not aggregated into the API's health response. Check each backend's `/ready` endpoint separately.

## Routine checks

- Inspect worker errors, invalid credentials, OTLP rejections, Redis quota failures, and storage health.
- Confirm agent heartbeats, backend disk space/WAL headroom, object-store growth, retention compaction, and notification retry counts.
- Review plan quotas, active series, label cardinality, query latency, and noisy-tenant pressure.
- Confirm that clock synchronization works on agents/storage hosts; telemetry timestamps are customer-supplied.
- Local notification messages are visible in Alerts → Notification history. SMTP retries up to five times with exponential delay.

## Backup and restore

PostgreSQL: take `pg_dump` through the deployment's backup tooling, write to a restricted backup location, and validate with `pg_restore` into an isolated database. Include all schema migrations and plan definitions. Do not print database credentials in shell logs.

Telemetry: replicate or back up the S3-compatible buckets plus configuration. The local stack uses RustFS. Do not assume a PostgreSQL backup contains telemetry. Preserve backend WAL volumes or use each backend's documented recovery procedure. Never copy an actively written database directory as a substitute for a consistent backup.

Demo only: stop the API before copying `backend/data/demo.json`; keep `.env` separate. Demo data is not a source for commercial customer recovery.

Restore metadata, then telemetry objects/configuration, start backend services, run tenant-isolation checks, and compare sample query windows. Conduct a restore drill before promising RPO/RTO. No numeric RPO/RTO has been established by this repository.

## Upgrade and rollback

Build and test a candidate against a restored staging copy. Use expand/contract database migrations so the prior app can run during rollout. `prisma migrate deploy` applies forward SQL only; there is no automatic down migration. For an irreversible migration, use a reviewed compensating migration or restore from a tested backup. Record versions, retain the prior image, stop workers while incompatible migrations run, and verify authentication, enrollment, all telemetry signals, and alert recovery afterward.

The current single-host Compose configuration has no high availability and a startup migration in its app command. Before multiple app replicas, move migrations to a one-time release job and extract worker execution. The Redis worker lease reduces duplicate ticks but is not a durable workflow engine; long-running ticks can outlive its lease. Notification delivery is at-least-once on crash boundaries, not exactly-once.

## Incident examples

**Storage down:** gateway returns 503, collectors retry and buffer. Recover storage before queues overflow. Node host-agent heartbeats do not have a durable local spool; use the OTel collector for durable telemetry buffering.

**Quota reached:** 429 with explanatory error. Verify traffic/plan limits and change entitlements through the backend. Do not bypass scope headers or expose the storage endpoint to make the error disappear.

**Token stolen:** revoke/rotate its project credential, deploy the new value from `.env`, inspect relevant audit/usage/ingestion logs. Tokens never grant access to query data.

**Alert storm:** silence the affected rule or enable a maintenance window; inspect threshold and pending duration. Current grouping is per rule/resource; organization-wide batched email grouping remains future work.

**Payment failure:** verify signed provider events and inspect subscription state. Mock invoices are simulations. Do not treat mock success as real settlement.

## Self-managed and growth deployment

The same connected stack can run on customer-owned infrastructure. Customers manage the whole stack and their own credentials/backups. A centrally licensed hybrid data-plane offering and offline enterprise installation need additional engineering listed in ROADMAP.md.

Scale PostgreSQL, API, query workers, and telemetry backends based on measured saturation. Move from monolithic Mimir/Loki/Tempo to supported distributed deployments when measurements justify them. Introduce a managed object store, independent ingestion/query pools, proper worker leases/queueing, and Kubernetes only with an actual operating need.
