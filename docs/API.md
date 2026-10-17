# API contract

Base path: `/api`. JSON errors use `{ "error": "Human-readable message" }`. Zod validates requests. Successful writes return the created/updated record, unless noted. Times are ISO 8601; monthly usage periods are `YYYY-MM`. Currency values in the mock plan API are whole INR, not payment-provider minor units.

User routes require `Authorization: Bearer <session-token>`. Optional `X-Organization-Id` chooses an organization the user belongs to. No tenant header grants access. `owner/admin/editor` may modify monitoring; `owner/admin` manage settings/team/keys; only `owner` changes subscriptions.

## Authentication and workspace

| Method / path         | Request / behavior                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET `/health`         | Public liveness plus metadata/Redis readiness.                                                                                                                       |
| GET `/auth/config`    | Public demo/provider capability flags, no credentials.                                                                                                               |
| POST `/auth/login`    | `{email, password}` → `{token, user:{id,name,email}}`.                                                                                                               |
| POST `/auth/register` | `{name,email,password,organization}`; password minimum 10 characters. Creates organization, owner, project, production environment, trial, email channel atomically. |
| POST `/auth/demo`     | Demo only. Returns seeded owner session; disabled in connected mode.                                                                                                 |
| GET `/bootstrap`      | Current user, permitted organizations/projects, role, subscription, plan, demo/provider flags.                                                                       |
| GET `/overview`       | Optional `projectId`, `environment`; inventory counts, resource snapshot, incidents, usage.                                                                          |

## Metadata and monitoring

| Method / path                       | Request / behavior                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| GET `/resources`                    | Filters: `type`, `projectId`, `environment`, `search`.                                                                              |
| POST `/resources`                   | `{name,projectId,type,environment?,labels?}`. Types: server/container/application/database. New manual resources are pending.       |
| DELETE `/resources/:id`             | Soft delete. Returns 204.                                                                                                           |
| GET, POST `/projects`               | Create `{name}`. Up to 20 projects per pilot organization.                                                                          |
| GET, POST `/environments`           | Create `{name,projectId}`; lowercase letters, digits, hyphens.                                                                      |
| GET `/members`                      | Admin. Members with public profile data; no password hashes.                                                                        |
| POST `/members`                     | `{name,email,password?,role,projectIds?}`. New accounts require initial password. role: admin/editor/viewer. No invitation is sent. |
| PATCH `/members/:id`                | `{role,projectIds?}`. Owner membership is protected.                                                                                |
| DELETE `/members/:id`               | Cannot delete owner or your own membership.                                                                                         |
| GET `/alerts`                       | `{rules,incidents}` within visible projects.                                                                                        |
| POST `/alerts/rules`                | `{name,projectId,metric,operator,threshold,durationSeconds?,cooldownSeconds?,severity?,enabled?}`.                                  |
| PATCH `/alerts/rules/:id`           | `{enabled?,silenceUntil?}`. `null` clears silence.                                                                                  |
| DELETE `/alerts/rules/:id`          | Disables rule.                                                                                                                      |
| PATCH `/alerts/incidents/:id`       | `{state: "acknowledged"                                                                                                             | "resolved"}`. |
| POST `/alerts/evaluate`             | Evaluate current organization's resource snapshots and local email outbox.                                                          |
| GET `/notifications`                | Admin. `{channels,deliveries,provider}`. Last 100 deliveries.                                                                       |
| POST `/notifications/channels`      | Admin. `{name,address}`. Email only.                                                                                                |
| PATCH `/notifications/channels/:id` | Admin. `{enabled}`.                                                                                                                 |
| GET, POST `/uptime`                 | Create `{name,projectId,target,intervalSeconds?,failureThreshold?}`. Minimum 60-second interval. Public HTTP/HTTPS/TCP targets.     |
| GET `/uptime/:id/checks`            | Last 100 checks.                                                                                                                    |
| POST `/uptime/:id/check`            | Run one check now.                                                                                                                  |
| PATCH `/uptime/:id`                 | `{enabled}`.                                                                                                                        |
| DELETE `/uptime/:id`                | Delete monitor and cascade historical checks in PostgreSQL.                                                                         |
| GET, PATCH `/settings`              | Admin. Update `{name?,settings?:{timezone?,maintenanceUntil?}}`.                                                                    |
| GET `/audit`                        | Admin. Last 100 audit entries for current organization.                                                                             |

Alert metric keys: `cpu`, `memory`, `disk`, `restarts`, `errorRate`, `p95`, `availability`, `certificateDays`. Operators: `gt`/`lt`; severity: `warning`/`critical`. Values are evaluated against the latest reported resource snapshot; application/database metric synchronization from exporters remains integration work. Missing metric values do not fire. See STATUS.md.

## Enrollment, configuration, and ingestion

| Method / path                    | Request / behavior                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| GET `/agents`                    | Visible agent records.                                                                                              |
| POST `/agents/enrollment-tokens` | User session. `{projectId}` → `{token,expiresAt,command}`. Single use, expires in 15 minutes.                       |
| POST `/agents/enroll`            | Public enrollment exchange `{token,name,platform,version?}` → `{agentId,token,endpoint,heartbeatIntervalSeconds}`.  |
| POST `/agents/heartbeat`         | Agent bearer credential. `{cpu,memory,disk?,cores,ramGb,uptimeSeconds,environment?,os}` → `{status,configVersion}`. |
| POST `/agents/:id/rotate`        | User editor+. Revokes old credentials and returns new token once.                                                   |
| POST `/agents/:id/revoke`        | User editor+. Revokes credentials and marks agent unavailable.                                                      |
| GET `/agents/:id/config`         | User session. YAML collector template with environment reference instead of token.                                  |
| GET, POST `/keys`                | Admin. Create `{name,projectId}` → metadata and plaintext token once. Keys are ingestion-only.                      |
| DELETE `/keys/:id`               | Admin. Revokes key; 204.                                                                                            |

Standard telemetry endpoints are **outside** `/api`:

```
POST /otlp/v1/metrics
POST /otlp/v1/logs
POST /otlp/v1/traces
Authorization: Bearer <agent-or-ingestion-key>
Content-Type: application/json OR application/x-protobuf
```

Body limit: 2 MiB after decompression. JSON requires a standard OTLP resource array for that signal, up to 100 resource groups and 128 attributes per list. Protobuf bodies are validated by the destination backend in connected mode. The gateway ignores all customer-supplied storage tenant headers and injects credential-derived storage identity. Monthly byte quota reservation occurs before forwarding; failed/retried upstream attempts can be conservatively counted again. This pilot metering is not a revenue-grade event ledger.

Success preserves the backend's OTLP response. Demo responses include `demo:true` and discard payloads. `429` indicates tenant byte/rate limits; `503` indicates storage unavailability and should be retried with exponential backoff. Plaintext HTTP is for local development; use TLS for remote enrollment/ingestion.

## Query API

```
GET /api/query/metrics?metric=cpu&range=1h&projectId=<id>
GET /api/query/logs?search=timeout&level=error&range=1h&projectId=<id>
GET /api/query/traces?service=checkout-service&range=1h&projectId=<id>
GET /api/traces/<32-hex-trace-id>?projectId=<id>
```

Ranges: `15m`, `1h`, `6h`, `24h`. Project optional for searches, required for trace detail. Metrics presets: cpu/memory/throughput/errors/latency. No arbitrary PromQL endpoint. Logs accept an escaped substring and exact service filter; maximum 200 rows. Traces use an exact service filter, maximum 100 matches per queried project, capped to 200 combined. Returned objects include `source: demo | live`. Metric search returns `{points,series?}`; log search `{entries}`; trace search `{traces}`. Cross-project metric series are returned individually; the current dashboard plots the first available project's series, which is identified in the API result.

## Billing state and entitlements

| Method / path           | Behavior                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET `/billing`          | Admin. Plans, subscription, invoices, usage, provider.                                                                                                                                                                    |
| POST `/billing/change`  | Owner. `{planId,interval:monthly                                                                                                                                                                                          | annual}`; mock subscription update and simulated invoice. |
| POST `/billing/cancel`  | Owner. Schedule cancellation at period end.                                                                                                                                                                               |
| POST `/billing/webhook` | Signed provider callback. Header `X-Pulse-Signature`: hex HMAC-SHA256 over raw body using `BILLING_WEBHOOK_SECRET`. Body `{id,orgId,type,amount?}`. This is Pulse's mock adapter contract, not Razorpay's webhook format. |

```
trialing -> active (mock change / payment success)
active -> past_due (payment failed)
past_due -> active (payment succeeded)
active -> cancelAtPeriodEnd (owner cancellation)
any -> cancelled (subscription.cancelled webhook)
```

Webhook IDs are unique and replay-safe through a metadata transaction. Seven-day grace applies to past_due using the subscription update timestamp. Production providers need provider event ordering and a dedicated stable grace deadline. Server/container/member/rule limits are checked on relevant writes; monthly metrics/log/trace byte quotas are checked before forwarding. Trial expiry and cancellation-at-period-end block telemetry queries/ingestion. Retention days are entitlements; physical per-plan retention overrides are not yet generated. Shared local backends retain 30 days.
