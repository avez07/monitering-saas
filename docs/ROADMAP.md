# Delivery roadmap and acceptance criteria

The latest instruction requested a continuous implementation pass, so the initial major-phase approval pauses were not used. The repository now contains a runnable development MVP and a roadmap for the remaining enterprise work.

## Phase 1 — working workspace

Implemented: architecture, React shell, all requested navigation areas, reusable UI, auth/organization/project services, tenant-aware API, metadata repository, Prisma schema/migration, persistent local demo, dummy .env values, startup docs.

Acceptance: a new owner registers into an empty workspace, sample data belongs only to the demo tenant, viewer writes fail, project assignments restrict results, no frontend service secrets, build succeeds.

## Phase 2 — ingestion and monitoring foundation

Implemented: single-use enrollment, hashed credentials, revoke/rotate, Node host heartbeat agent, standard OTLP/HTTP gateway, Mimir/Loki/Tempo adapters/configs, project query service, live error reporting, JSON service discovery, local Docker stack, source-redaction collector template.

Acceptance: credential identity determines storage tenant, all three signals can be stored and queried, a revoked agent fails authentication, retries/backpressure behave under an outage. Automated gateway routing tests can run without Docker; full storage validation requires the connected stack.

Remaining: full runtime exporter packages, richer host/process/network/container dashboards, automatic metadata discovery for protobuf, per-resource live metric synchronization and standardized application/database metric coverage.

## Phase 3 — operations and pilot controls

Implemented: resource-snapshot alert state machine, pending/firing/acknowledge/recovery, cooldown, silencing, maintenance email pause, delivery history/retries, local/SMTP adapters, public uptime checks, DNS pinning/address checks, simple subscription states, plan limits/byte metering, signed idempotent mock webhooks, simulated invoices, team and audit.

Acceptance: pending/firing/recovery notifications work, private uptime targets are rejected, webhook replay has no repeated payment effect, limits are enforced server-side, browser workflows work on desktop/mobile.

Remaining: production payment adapters with event ordering and proration, stable payment grace deadlines, tax invoices, real provider trials/settlement tests, customer password recovery, production email verification/invitations, aggregation of email alerts, long-duration scheduler recovery, per-plan physical retention overrides and revenue-grade usage accounting.

## Phase 4 — real pilot validation

Required before paid onboarding: sustained ten-tenant telemetry load, noisy-neighbor tests, exporter/SDK test matrix, installer OS/architecture matrix, recovery/restore drills, upgrade/rollback exercise, measured cost model and hardware minima. Use real 5–10 pilot customers only after those checks and monitoring of Pulse itself.

## Phase 5 — deployment expansion

Customer-owned data planes with cloud control plane; approved, verified installers for Linux/Windows/Docker/Helm; signed auto-updates; license lifecycle and upgrade coordination; Kubernetes workload resource views backed by integrations; regional uptime probes; configurable dashboards; SSO/custom RBAC if demanded; fully isolated enterprise installation.

Do not add distributed infrastructure merely to fill out a diagram. First prove ingestion/query headroom and recovery behavior at the target workload.
