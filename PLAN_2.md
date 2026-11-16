# YuktiOps: PLAN_2 — scale-out (Redis + queues) and every "coming soon" item

> After approval this file is saved in the repo as **`PLAN_2.md`** (read "PLAN_@" as PLAN_2, since `@` is Shift+2). `PLAN.md` stays as the record of Phases 0–15.

## Context

Phases 0–15 are built, but two gaps remain:

1. **The backend can't scale out.** Today everything runs in a few processes against Postgres:
   - **Ingest is fully synchronous.** `/v1/ingest` (`backend/src/routes/v1.js:221-361`) writes metrics, container/service upserts, events and trims to Postgres before it replies.
   - **State lives in process memory.** Rate limits and login lockouts (`services/limits.js`) and the agent cache (`services/agent-cache.js`) are per process. With 2+ API instances, limits multiply, lockouts can be bypassed, and a revoked credential keeps working for up to 2 minutes on other instances.
   - **One worker does everything in series.** A single `WorkerLease` leader (`services/workers.js`) runs website checks, then alert evaluation, notification delivery and housekeeping, one after another.
     - Alert evaluation is O(rules × servers) queries.
     - Notifications are sent one at a time (`contacts.js:239`), so one slow SMTP server delays every customer.
     - A crashed worker leaves up to 90 s with no checks.
   - **Retention uses big DELETEs.** Hourly DELETE trims (`metrics.js:39`) compete with ingest. There is no PgBouncer and no Redis.

   The load test (`docs/ops.md`) passed at 500 agents, but this design tops out on one VM and can't add instances.

2. **Several features are still "coming soon", "later" or deferred** in the UI, site, agent and docs (inventory below).

3. **Problems found in your hands-on test:**
   - **No OpenTelemetry.** There's no easy way to send an application's traces and logs and customise them.
   - **Containers need a server first.** You can't monitor Docker containers without first "adding a server".
   - **Services send you to Servers.** The Services page redirects to the Servers tab instead of letting you add a service there.
   - **Currency:** billing should be rupee-first.
   - **Setup isn't explained.** The download button doesn't say how to set the agent up.
   - **The Docker command fails on Windows** with `mkdir C:\Program Files\Git\var: Access is denied`.

**Goal:**
1. Fix what you hit in testing (Part C).
2. Make the platform horizontally scalable: Redis + BullMQ, multiple API and worker instances, Postgres protected by queues and batching (Part A).
3. Ship OpenTelemetry for customers, then every remaining deferred feature, in small, testable phases (Part B).

---

## Part C — Fixes from your testing (Phase 16) ✅ done (see status note at the end)

### C.1 Docker install fails on Windows (`mkdir C:\Program Files\Git\var: Access is denied`)

- **Cause:** you ran the snippet in **Git Bash**. MSYS rewrites Unix paths in arguments, so `-v /var/run/docker.sock:/var/run/docker.sock` became `C:\Program Files\Git\var\…`, and Docker tried to create that folder. The snippet (`frontend/src/pages/add-server/model.js:119-160`, `dockerRun`/`dockerCompose`) assumes a Linux shell.
- A second, hidden problem: the agent image only sees its **own container**, not the host. G1 noted "Docker image container stats are container's view only". The snippet also has no host mounts.
- **Fix:**
  - **Wizard "Docker" tab asks "Where are you running Docker?":**
    - **Linux server (recommended):** command with host mounts: `--pid host --network host -v /:/host:ro -e HOST_ROOT=/host`, plus `-v /var/run/docker.sock:/var/run/docker.sock:ro` when Containers is on.
    - **Windows (Docker Desktop):** a PowerShell version (backtick line breaks, the same paths; PowerShell doesn't rewrite them) and a Git Bash version prefixed with `MSYS_NO_PATHCONV=1` (or `//var/run/docker.sock`).
    - **macOS (Docker Desktop):** its own snippet.
    - The page states plainly that on Docker Desktop the agent monitors Docker's Linux VM and your containers, **not** the Windows/Mac computer itself.
  - **Agent:** honour `HOST_ROOT` for `/proc`, `/sys` and mount paths in `agent/internal/collect` and `config/paths.go`, so the container reports the host. `Dockerfile.release` documents the mounts.
  - The compose snippet gets the same mounts. Add a `doctor` check: "running in a container without host mounts: you will only see the container".
  - **Tests:** snippet unit tests per shell, and the agent in a container with `/:/host:ro` reports host totals (Docker e2e).

### C.2 Containers without "adding a server" first

- **Problem:** the Containers page empty state only says "Open your servers" (`pages/containers/index.jsx:35`).
- **Fix:** a **"Monitor Docker containers"** flow starting on the Containers page, with a short 3-step dialog:
  1. Where is Docker running (Linux / Windows / Mac)?
  2. Get the API key, then copy the Docker command with the containers collector already on (reuses `KeyPanel.jsx`, `Command.jsx` and the setup profile from `/api/agent-configs` with `collectors.docker=true`).
  3. Wait for the first containers to arrive (reuses `StepWait.jsx` polling).
- Internally it's still an agent. The UI calls it a **"Docker host"**: a host `kind` (`server` | `docker-host`) on the agent/resource, set from the setup profile.
- Docker hosts show on the Containers page first and are filtered out of the Servers list by default ("Show Docker hosts" toggle). Plan server limits count hosts the same way; we don't add a new price.
- If agents already exist, the dialog also offers "Turn on containers for an existing server" (one switch, saved through the existing `PATCH /api/servers/:id` config, no navigation away).

### C.3 Services without being sent to the Servers tab

- **Problem:** the Services empty state redirects to `/servers` (`pages/services/index.jsx:39`).
- **Fix:** an **"Add a service"** dialog on the Services page:
  1. Pick the type: website/API, TCP port, nginx, Apache, MySQL, Postgres, Redis, systemd service or process.
  2. **If it can be checked from outside** (website, API, public TCP port), create a Websites & APIs monitor directly, with no agent needed.
  3. **Otherwise**, pick the host it runs on (or "Install the agent on that host" → the same small dialog as C.2), then fill the name/port/URL and save. This updates that host's `collectors.services[]` via the existing config API; the agent picks it up on its next config pull.
  4. Show "Waiting for first result…" inline.
- Service rows link to the service detail, not the server page.
- **Backend:** `POST /api/services` (validates, writes into the host's AgentConfig, returns a pending item), `DELETE /api/services/:id`.

### C.4 Rupee-first billing (INR default, USD optional)

- **Backend:**
  - Default currency becomes **INR** everywhere: the `currency` default in `routes/billing.js:86`, the dev/mock invoice in `services/billing.js:28`, and `GET /api/billing` returns `defaultCurrency: 'INR'`.
  - INR → Razorpay with GST; USD → Stripe, only when the customer picks USD.
  - Once subscribed, the currency is locked (already enforced at `routes/billing.js:125`).
- **App (`pages/settings/Plan.jsx`):** INR selected by default, formatted `en-IN` (₹1,999); toggle "Pay in USD instead"; prices shown "+ 18% GST" for INR.
- **Site (`site/src/components/PricingGrid.astro`):** INR default, USD toggle.
- **Tests:** default currency, GST lines, USD path still works.

### C.5 Clear setup guide (beyond the README)

- **In the wizard:**
  - Every install tab gets numbered steps with **what each command does**, the expected output, and a "check it worked" step (`yuktiops-agent status`).
  - A collapsible "Something went wrong?" list per step.
  - The Download tab gets full per-package steps:
    - **.deb:** download → `sudo dpkg -i` → `register` → `enable --now` → verify.
    - **.rpm:** download → `sudo rpm -i` → the same steps.
    - **.tar.gz:** download → extract → move binary → create user/dirs → install unit → register → start → verify.
  - Download `agent.yaml` with comments.
  - "Copy all steps" button and a "Print/PDF guide" view.
- **Docs site:** step-by-step pages per OS and per method (one command, .deb, .rpm, tarball, Docker on Linux, Docker Desktop on Windows/Mac), with screenshots of the dashboard at each step, an uninstall/upgrade section, and a 2-minute "what happens on your server" explainer.
- **`agent/README.md`:** rewrite into a short, plain-language quick start at the top, with reference material below.
- **Done when:** a non-technical tester follows only the guide, from download to data, with no help (scripted e2e for the commands in a fresh Ubuntu container and Docker Desktop on Windows).

---

## Part A — Scale-out architecture (Phase 17)

### A.1 Target design

```
 agents ──HTTPS──▶ Caddy (LB) ──▶ API ×N (stateless) ──▶ Redis 7 (AOF)
                                     │ validate+auth           │  rate limits, lockouts, agent-ctx cache,
                                     │ enqueue, reply 202      │  last-seen ZSET, config versions, pub/sub
                                     ▼                          ▼
                              BullMQ queues ──▶ workers ×M (by role)
                              ingest · side-effects · checks · alerts · notify · housekeeping
                                     │ batched writes
                                     ▼
                              PgBouncer ──▶ Postgres 16 + TimescaleDB
```

- **Library:** `bullmq` + `ioredis` (Node standard, retries/backoff/rate limits/job schedulers built in) and `rate-limiter-flexible` (Redis-backed, atomic). Redis is **required** in every environment, including dev and tests (docker compose).
- **Code shape:** a new `backend/src/lib/redis.js` (one connection factory with key prefix `yk:`) and `backend/src/queues/` (one file per queue: definition + processor). `worker.js` becomes `worker.js --role=ingest|checks|alerts|notify|housekeeping|all` (default `all` for dev).

### A.2 Ingest pipeline

- **API path:**
  - Auth from the Redis agent-context cache. On a miss, load from DB using the existing 5-query loader in `agent-cache.js`, then cache.
  - Zod validation, then a size check (as today).
  - `queue.add('ingest', payload)` (gzip body kept compressed in Redis).
  - Reply `202 {configVersion}`, with the config version read from Redis.
  - Target: < 5 ms of server work, no DB writes.
- **Backpressure:** if ingest queue lag passes a threshold (e.g. > 50k jobs or oldest > 60 s), the API answers `503 Retry-After`. The Go agent already buffers 15 minutes and backs off, so no data is lost. The agent treats 503 like an outage (`agent/internal/runner`).
- **Ingest workers:**
  - Pull jobs in batches and write `server_metrics` / `container_metrics` with multi-row inserts every ≤1 s or 1000 rows.
  - Upsert container/service current state only when it changed (diff against a Redis hash).
  - Push "first data", "clock skew" and agent errors to a `side-effects` queue (events + trims; dedupe key in Redis replaces `recordDeduped`'s findFirst).
  - Jobs are idempotent: metric PK + `skipDuplicates` already exist.
- **Last-seen and status:** `ZADD yk:lastseen <ts> <agentId>` on every accepted ingest. Agent `lastSeenAt` and resource status are flushed to Postgres by a batch job every 30 s, replacing the per-request throttled UPDATEs in v1.js:267-309. Offline detection scans the ZSET (`ZRANGEBYSCORE`) instead of loading every agent row (`workers.js` housekeeping).
- **Invalidation:**
  - Store writes publish `yk:agent:invalidate <agentId|*>` on Redis pub/sub. Every API instance drops matching entries, which replaces the per-process `epoch` in `data/store.js:16`.
  - Revocation also writes `yk:revoked:<credId>`, which is checked on every request. Revocation becomes instant on all instances.
- `/v1/register`, `/v1/config` and `/v1/install-events` stay synchronous (low volume) but use the Redis limiter and cache.

### A.3 Shared state → Redis

- Rewrite `services/limits.js` behind the same interface (`hit`, `record`, `assertUnder`, lockouts) on `rate-limiter-flexible` with Redis. Existing callers stay unchanged, and the in-memory sweeps are removed.
- The releases cache (`routes/downloads.js`) and the RDAP bootstrap cache move to Redis with a TTL (minor).
- Sessions stay in Postgres (already safe across instances). Add a 60 s Redis read-through cache for session lookups, invalidated on logout or member removal.

### A.4 Worker split (replaces the single lease)

| Queue | Producer | Processing | Concurrency / scaling |
|---|---|---|---|
| `checks` | BullMQ **job scheduler** per monitor (repeat = monitor interval), synced on create/update/pause/delete in `routes/websites.js` | one job = one check (existing `checkTarget` + SSRF guard + retry-before-down in `services/checks.js`) | per-worker concurrency 50, per-host limiter via group key; scale horizontally |
| `alerts` | scheduler every 30 s → one job **per org** | evaluate rules with **one SQL per rule** over all subjects (window aggregate: `min/max` per agent over `now()-duration` from `server_metrics` / 5-min aggregate), not per-subject queries (`alert-metrics.js:41`) | parallel across orgs; incident state machine unchanged (`services/alerting.js`) |
| `notify` | `enqueueNotifications` creates the outbox row **and** a job (`jobId = deliveryId`) | one job = one delivery via existing transports (`services/contacts.js`); pooled SMTP transport | concurrency 20; per-provider rate limit (Telegram 25/s, Slack 1/s per webhook); exponential backoff; 5 attempts then dead-letter, visible in UI |
| `side-effects` | ingest workers | agent events, trims, first-data | concurrency 10 |
| `housekeeping` | schedulers (cron) | session purge, event purge, dunning (hourly), domain-expiry refresh, retention | single-run guaranteed by scheduler |

- `WorkerLease` is removed. BullMQ guarantees each scheduled job runs once even with many workers.
- Each worker role gets a `/healthz` (queue connection + last processed time). The prod compose gets healthchecks and `restart`.

### A.5 Database protection

- **PgBouncer** in transaction mode in front of Postgres. Prisma URLs get `?pgbouncer=true&connection_limit=…`; migrations use a direct URL (`directUrl` in `schema.prisma`).
- **Retention:**
  - Replace the hourly `trimRawMetricsByPlan` DELETE (`metrics.js:39`) with Timescale `add_retention_policy` (chunk drop) at the longest plan retention, plus query-time clamping by plan (already done in the metrics API).
  - Make sure compression policies are on.
  - Do the same for `container_metrics`, and add its 1-hour continuous aggregate (closes the "container rollups > 7 days" gap).
- Ingest batching (A.2) cuts Postgres round-trips by roughly 10×.
- A read replica is noted for later (dashboards and chart reads). It isn't needed at this size.

### A.6 Deploy and observability

- `docker-compose.yml` (dev) and `docker-compose.prod.yml` add `redis:7` (AOF `everysec`, `maxmemory-policy noeviction`, password, no public port) and `pgbouncer`.
- `api` gets `deploy.replicas: 2` behind Caddy `reverse_proxy` with health-checked load balancing. Workers run by role.
- `.env.production.example` gets `REDIS_URL`; `docs/ops.md` and `docs/runbook.md` get Redis backup (AOF + RDB snapshot to R2), "queue backlog" and "Redis down" runbooks.
- **Internal `/metrics` (Prometheus format, internal network only):** queue depth/lag per queue, ingest accept rate, batch insert latency, alert evaluation duration, notification failures. Add Bull Board at `/admin/queues`, behind a staff-only basic auth env.
- Graceful shutdown: the API stops accepting, then closes Redis. Workers finish the active job, then close.

### A.7 Tests and load targets

- Unit/integration tests run against real Redis from compose, with a separate DB index per test run (like `TEST_DATABASE_URL`, add `TEST_REDIS_URL`).
- New tests:
  - Limiter shared across two app instances, and a lockout can't be bypassed through the other instance.
  - Revoke is effective on instance B immediately.
  - Ingest 202 → rows appear after the worker drains.
  - Backpressure returns 503.
  - A notification job retries then dead-letters.
  - A scheduler fires once with 3 workers.
  - Alert window SQL: a 4-minute spike doesn't fire a 5-minute rule (re-run the existing alert tests).
- Extend `deploy/loadtest/loadtest.mjs` with `--apis` (multiple targets) and a queue-lag readout.
- **Done when (on one 8-vCPU VM):**
  - 5,000 agents at 30 s (≈170 req/s) for 30 minutes.
  - A 10× burst (1,700 req/s) for 2 minutes.
  - Ingest accept p99 < 50 ms; queue lag p99 < 10 s; 0 data loss.
  - Killing one API and one worker mid-run causes no errors beyond retries.
  - Alert latency stays within the 3-minute offline target.
  - 2,000 website monitors finish within their intervals.

---

## Part D — OpenTelemetry for customers (Phase 18)

**Goal:** a customer instruments their app with the standard OpenTelemetry SDK or Collector, points it at YuktiOps with one key, and sees **traces and logs** (plus RED metrics) in the dashboard. Customising is just normal OTel: custom spans, attributes, log fields, sampling.

### D.1 Ingest (OTLP)

- **Endpoints** (standard paths, so any SDK works unchanged):
  - OTLP/HTTP: `https://otlp.yuktiops.com/v1/traces`, `/v1/logs`, `/v1/metrics` (protobuf and JSON, gzip).
  - OTLP/gRPC on `:4317` via Caddy h2c passthrough.
- **Auth:** header `x-yuktiops-key: yk_otel_…`. This is a new **telemetry ingest key** type, write-only and per environment, created in Settings → API keys. It reuses the `ApiKey` model with a `kind` column and the hash/show-once logic in `services/api-keys.js`.
- **Pipeline:** API validates key + size, then pushes raw batches to a BullMQ `otel` queue (Part A), and returns `200` with OTLP `partial_success` on drops.
  - Workers decode with `@opentelemetry/otlp-transformer` / protobufjs.
  - They apply **redaction rules** (org-defined: drop or hash attributes such as `http.request.header.authorization`, emails, card numbers) and the **sampling** settings.
  - Then they batch-insert into storage.
- **Storage: ClickHouse** (single node first, beside Postgres), with tables `otel_traces` and `otel_logs` using the schema of the official OTel Collector ClickHouse exporter, so it's well-known and fast.
  - TTL per plan (Free 3 days, Starter 7, Pro 15, Business 30).
  - Materialized views for per-service RED metrics: rate, errors, p50/p95/p99 duration per minute.
  - Postgres/Timescale is not used here; spans and logs are too big for it.
- **Limits:** GB per month per plan, tracked in Redis counters and shown on the Plan page. When over, respond `429` with OTLP retry info and email the owner at 80% and 100%.

### D.2 Easiest setup ("Connect your app" page, also offered from the Overview)

- Pick the language: Node.js, Python, Java, Go, .NET, PHP, Ruby, or "OpenTelemetry Collector".
- **Zero-code auto-instrumentation snippets**, using only standard env vars:
  ```
  OTEL_SERVICE_NAME=checkout-api
  OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.yuktiops.com
  OTEL_EXPORTER_OTLP_HEADERS=x-yuktiops-key=yk_otel_…
  OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production
  ```
  plus the 1–2 install lines per language: `npm i @opentelemetry/auto-instrumentations-node` and `node --require @opentelemetry/auto-instrumentations-node/register app.js`; `opentelemetry-bootstrap`; the Java agent `-javaagent:` flag; and the rest.
- **"Customise" tab** with copyable examples per language:
  - custom span + attributes;
  - add user/order ids;
  - record exceptions;
  - log correlation (trace id in logs);
  - sampling ratio (`OTEL_TRACES_SAMPLER=parentbased_traceidratio`);
  - ignoring health-check routes.
- Collector config snippet: `otlphttp` exporter with our header, plus a `filelog` receiver for shipping existing log files.
- A live **"Waiting for your first trace…"** check (polls a per-key "last seen" in Redis), with error hints for a wrong key, wrong endpoint, firewall or TLS.
- Optional: the YuktiOps agent can run a **localhost-only** OTLP forwarder (opt-in, binds 127.0.0.1:4318 only), so apps on the server send locally and the agent batches/retries them. This is off by default to keep the "no open ports" promise; the docs explain it.

### D.3 Dashboard (new sidebar section **"Apps"**)

- **Services list:** request rate, error %, p95, sparkline, and the status word.
- **Service detail:**
  - RED charts and top endpoints (slowest/most errors);
  - recent errors grouped by exception type;
  - a "View traces" filter.
- **Traces explorer:** filter by service, endpoint, status, duration > X, attribute = value, and time range. The **trace waterfall** shows spans, attributes and events, with links to related logs.
- **Logs explorer:** search (ClickHouse `hasToken`/full-text index), filter by service, severity, trace id or attributes; live tail mode; jump to the trace.
- **Alerts:** new templates, "Error rate above 5% for 5 minutes", "p95 latency above 1 s" and "No traces received for 10 minutes", plugged in through `registerMetricSource` (`services/alert-metrics.js`) and reading the ClickHouse materialized views.
- **Settings → Telemetry:** ingest keys, redaction rules, sampling, retention, and usage in GB.

### D.4 Done when

- Sample apps (Node Express, Python Flask, Java Spring, Go) with **only env vars** show traces and correlated logs within 1 minute.
- Custom span and attribute examples show up.
- Redaction removes the configured attributes before storage.
- 5k spans/s sustained on one node, with a trace query (by service, last 1 h) taking < 500 ms.
- Over-quota returns 429.
- The e2e test covers the Connect-your-app flow and the trace waterfall; axe shows 0 violations.

---

## Part B — Roadmap: every phase in order

Inventory (found in code/UI/docs):
- Wizard: Windows/macOS cards (`StepWhere.jsx:8-11`); Web server and Databases options (`StepWhat.jsx:48,52`).
- Site copy: out of date (`features.astro:27`, `docs/alerts.md:25` still say Docker/services are "later").
- Account: no profile name, password change, delete org or transfer ownership (promised in `docs/team-roles.md:19`).
- Billing: extra servers never charged (`limits.js:88`, Stripe `quantity: 1`); no Razorpay portal (`billing.js:171`); no GST invoice PDFs.
- Containers: no data beyond 7 days.
- PLAN "Later": Windows/macOS agents, apt/yum repos, signed auto-update, public status pages, multi-region checks, read API + Prometheus export, PagerDuty/Opsgenie, log tail, Groups.
- Not verified yet: 24-hour soak, real R2/cosign/GHCR.

| Phase | What | Depends on | Done when |
|---|---|---|---|
| ✅ **16 — Fixes from testing** | All of Part C: Windows Docker command fix and host-mount agent image, Containers without a server ("Docker host"), "Add a service" on the Services page, INR-default billing, step-by-step setup guide | — | each C.x done-when; existing e2e green |
| **17 — Scale-out** | All of Part A (Redis, BullMQ, PgBouncer, stateless API ×N, workers by role) | 16 | Part A load targets met; all existing tests green |
| **18 — OpenTelemetry for customers** | All of Part D (OTLP ingest, ClickHouse, Apps section, traces/logs explorers, setup page) | 17 | D.4 |
| **19 — Account gaps and copy** | • Fix stale site/docs copy<br>• **Account:** change name (`PATCH /api/auth/me`), change password in place (current + new; revokes other sessions), transfer ownership (owner → existing admin, email confirmation), delete organization (owner, type-name confirm, 7-day soft delete then purge job on `housekeeping`)<br>• Remove the unused `ComingSoon` component | — | e2e covers each action; docs/team-roles.md matches |
| **20 — Web server and database monitoring (deep)** | • **Wizard:** enable "Web server" (nginx `stub_status` / Apache `server-status`: requests/s, active connections, error rate from status) and "Databases"<br>• **Agent:** deep metrics with credentials **only in local** `/etc/yuktiops/secrets.yaml` (0600, never sent):<br>&nbsp;&nbsp;– MySQL: connections, QPS, slow queries, replication lag<br>&nbsp;&nbsp;– Postgres: connections, TPS, cache hit, replication lag, DB size<br>&nbsp;&nbsp;– Redis: memory, ops/s, hit rate, evictions<br>• **Backend:** new metric families in a `service_metrics` hypertable; charts on the Services page; new alert templates ("Database connections near max", "Replication lag high")<br>• `yuktiops-agent secrets set mysql` helper | 17 | each collector tested against real DB containers; wizard YAML shows secrets hint, not values |
| **21 — Billing completion** (INR default already done in 16) | • **Per-extra-server billing:** Stripe quantity / metered item, Razorpay addon, prorated, shown on Plan page<br>• **Razorpay self-service:** in-app cancel / change plan / update card via subscription-update link<br>• **GST tax invoices:** sequential FY numbering, CGST/SGST vs IGST by state, PDF via `pdfkit`, stored in R2, emailed, downloadable in Settings<br>• Telemetry GB usage billed per plan (from Phase 18)<br>• Turn off "Payments are not available yet" when keys are present | 17 (notify queue for emails) | mocked-provider tests; sample PDF reviewed; GST math tests |
| **22 — Public status pages** | Status page per org (choose monitors and servers, custom name/logo/colours from theme, incident notes, 90-day uptime bars); hosted at `status.yuktiops.com/<slug>` or a custom domain (CNAME + Caddy on-demand TLS with an allow-list check endpoint); cached in Redis, served without auth; subscribe by email | 17 | axe 0 violations; custom-domain TLS works in staging; 1k req/s cached |
| **23 — Multi-region checks** | Check runners in 3 regions (small VMs; separate `checks-<region>` queues on the central Redis over TLS, or regional Redis + HTTPS result push); mark down only on **quorum** (2 of 3 regions fail); per-region latency charts; region choice by plan | 17 | a site blocked from one region shows "degraded", not down; failover tested |
| **24 — Integrations** | • **Read API:** scoped tokens (`read:metrics`, `read:alerts`), separate from the install key; OpenAPI doc; rate-limited via Redis<br>• **Prometheus export:** `/api/export/prometheus` per org token (last values), plus docs for remote scraping<br>• **PagerDuty** (Events v2) and **Opsgenie** contacts (trigger/resolve with dedup key) on the notify queue<br>• Signed webhook events catalogue | 17 | contract tests per provider (mocked); token scopes enforced |
| **25 — Agent distribution and trust** | • **apt and yum repositories** on R2 (signed `Release` / `repomd.xml` with a GPG key kept in GitHub secrets), built in the release workflow<br>• **Signed auto-update** in the Go agent (opt-in channel stable/beta, verifies cosign/minisign signature with an embedded public key, atomic swap + rollback on failed health)<br>• Open-source the agent repo (Apache-2.0)<br>• Real R2 + GHCR + cosign release run<br>• 24-hour soak on a real VPS | needs your R2, GHCR, GPG | `apt install yuktiops-agent` works on Ubuntu/Debian; tampered update refused; soak < 25 MB / < 1% |
| **26 — Windows agent** | Collectors via Windows APIs (PDH counters, `GetDiskFreeSpaceEx`, WMI-free where possible); Windows Service (via `golang.org/x/sys/windows/svc`); MSI installer (WiX) signed; PowerShell one-liner; `doctor`; wizard card enabled | 25 (signing) | install → data on Windows Server 2019/2022 < 2 min; uninstall clean |
| **27 — macOS agent** | Collectors (`sysctl`, `host_statistics`, IOKit disk); launchd daemon; signed + notarized pkg; Homebrew tap; wizard card enabled | 25 | install → data on macOS 14/15 (arm64 + amd64) |
| **28 — Server log tail** | Opt-in agent tail of chosen files/journald units (local allow-list in config; size and rate caps; redaction of common secrets). Lines go into the **same ClickHouse `otel_logs` store and Logs explorer as Phase 18** (tagged by host), so server logs and app logs are searched together; "error spike" alert | 18 | 10 servers × 100 lines/s sustained; redaction tests; disabled by default |
| **29 — Groups** | Bring back projects as **Groups** (tag servers/sites/apps, filter all pages, scope alert rules, optional per-group viewer access) | 19 | e2e: viewer limited to one group sees only it |
| **30 — Launch readiness** | Lawyer-reviewed legal text, real contact details, production deploy on Hetzner per `docs/ops.md`, first R2 release, beta invite | your accounts | live site + app + first external customer onboarded |

### Order and parallelism

- **16 first:** small, user-visible fixes; can start immediately.
- **17 next:** it changes the ingest, worker and notification core that every later phase plugs into. 16 and 17 can overlap, because their files barely touch.
- **18 (OTel) after 17:** it needs the queue and adds ClickHouse.
- **In parallel with 18:** 19 and 21; 20 (agent + backend); 22 and 24.
- **Later:**
  - 23 once 17 is stable in production.
  - 25 → 26 → 27 in sequence (signing first).
  - 28 after 18 (it reuses the logs store).
  - 29 last.
  - 30 runs alongside, whenever you have the accounts.
- Same multi-agent model as before: each agent owns its files, contracts in `docs/api/*.md` first, own test DB and Redis DB index, coordinator commits "Phase N: …".
- Frontend rules unchanged: Tailwind v3, JSX, shadcn@2.3.0, theme variables only.

## Critical files

**Phase 16 (fixes)**
- **Wizard:** `frontend/src/pages/add-server/model.js` (`dockerRun`/`dockerCompose` per shell + host mounts), `StepInstall.jsx` (numbered guide, per-package steps).
- **Pages:** `frontend/src/pages/containers/index.jsx` (Docker host dialog), `frontend/src/pages/services/index.jsx` (Add a service dialog), reusing `add-server/{KeyPanel,Command,StepWait}.jsx`.
- **Billing:** `frontend/src/pages/settings/Plan.jsx`, `site/src/components/PricingGrid.astro` (INR default).
- **Backend:** `backend/src/routes/billing.js:86` and `services/billing.js:28` (INR default); new `POST/DELETE /api/services` in `routes/services.js`; host `kind` on agent/resource (migration).
- **Agent:** `agent/internal/collect` + `config/paths.go` (`HOST_ROOT`), `agent/Dockerfile.release`, `agent/internal/cli` (doctor container check), `agent/README.md`.
- **Docs:** `site/src/content/docs/install*.md` (per-method guides).

**Phase 18 (OTel)**
- **New backend:** `backend/src/routes/otlp.js`, `backend/src/queues/otel.js`, `backend/src/lib/clickhouse.js` with ClickHouse migrations under `backend/clickhouse/`.
- **Changed backend:** `services/api-keys.js` (key `kind`), `services/alert-metrics.js` (new sources).
- **Frontend:** `frontend/src/pages/apps/` (list, detail, traces, logs, connect).
- **Infra:** ClickHouse in the compose files.

**Phase 17 (scale-out)**
- **New:** `backend/src/lib/redis.js`, `backend/src/queues/{ingest,side-effects,checks,alerts,notify,housekeeping}.js`, `backend/src/routes/metrics-internal.js`
- **Rewrite:**
  - `backend/src/services/limits.js` (same interface)
  - `services/agent-cache.js` (Redis + pub/sub)
  - `services/workers.js` and `worker.js` (roles, schedulers; remove lease)
  - `routes/v1.js` ingest handler (enqueue + 202)
  - `services/metrics.js` (batch writer, remove DELETE trim)
- **Adjust:**
  - `services/checks.js` (single-check job)
  - `services/contacts.js` (`deliverOne` job, pooled SMTP)
  - `services/alerting.js` + `alert-metrics.js` (set-based window SQL)
  - `data/store.js` (publish invalidations)
  - `prisma/schema.prisma` (`directUrl`, drop `WorkerLease` later)
  - `docker-compose*.yml`, `deploy/Caddyfile`, `.env*.example`, `deploy/loadtest/loadtest.mjs`
  - `agent/internal/runner` (treat 503 like 429/outage)

## Verification

0. **Phase 16 checks:**
   - Run the wizard's Docker command in **PowerShell, Git Bash and cmd** on this Windows machine. The container starts with no `C:\Program Files\Git\var` error.
   - Run it on a Linux host. The agent reports host totals, not container totals.
   - Add containers from the Containers page and a service from the Services page without ever opening Servers.
   - The Plan page opens in ₹ with GST.
   - A tester follows the written guide end to end.
1. `docker compose up -d postgres redis pgbouncer clickhouse mailpit`, then `npm test` (backend, all existing + new Redis/queue tests), `npm run test:e2e` (22 journeys still pass), and `npm run agent:test`.
2. Two API instances plus three workers locally (compose `--scale api=2`), run the journey e2e against Caddy, and check limits/lockouts/revoke across instances.
3. Run `node deploy/loadtest/loadtest.mjs --agents 5000 --duration 1800`, and the 10× burst, and record the results in `docs/ops.md`. Kill an API and a worker during the run.
4. Each Part B phase has its own "done when" above, plus the e2e and axe checks used so far.

## Decisions you may want to change

- Redis + BullMQ (not Kafka/NATS). It's simplest for one VM up to ~10k agents. Kafka is overkill now.
- Ingest becomes asynchronous (202). Dashboards may lag up to a few seconds behind.
- **ClickHouse for traces and logs** (Postgres/Timescale can't hold span and log volume cheaply). It adds one more database to run; managed ClickHouse Cloud is an alternative later.
- **OTel uses a separate write-only "telemetry key"**, never the server-install key.
- **Server log tail reuses the OTel logs store** instead of a separate live-only stream.
- **Docker hosts count against the plan's server limit** (no new price).
- Windows comes before macOS, because servers matter more than laptops for this audience.

## Status

- ✅ **Phase 16** built and tested (backend 156 tests, frontend 8, agent go vet/test, site build, e2e 22/22).
  - Not yet done from C.5: dashboard screenshots in the docs, scripted fresh-Ubuntu / Docker Desktop install e2e, Docker e2e proving `/:/host:ro` reports host totals, and running the new Docker snippets on a real Windows machine.
  - Site docs contain example output that should be checked against the real agent.
