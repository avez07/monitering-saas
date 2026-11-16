# Apps (OpenTelemetry) API (Phase 18, backend)

Two parts: the **OTLP ingest** endpoints that customer SDKs and Collectors call (key auth, no cookie), and the
**dashboard API** under `/api/apps` and `/api/telemetry-keys` (session cookie, org-scoped, same conventions as the
rest of `/api`: errors are `{ "error": "..." }`, ids are opaque strings, times are ISO-8601 UTC).
Any member (including `viewer`) can read; writes need `owner` or `admin`.

Storage is ClickHouse (traces and logs), not Postgres. If ClickHouse is down, read endpoints answer
`503 { "error": "Telemetry storage is unavailable. Try again shortly." }`.

## 1. OTLP ingest

| Method | Path | Body |
|---|---|---|
| POST | `/v1/traces` | `ExportTraceServiceRequest` |
| POST | `/v1/logs` | `ExportLogsServiceRequest` |
| POST | `/v1/metrics` | `ExportMetricsServiceRequest` (accepted, **not stored yet**; see below) |

- `Content-Type: application/x-protobuf` or `application/json` (OTLP/JSON: hex trace/span ids, camelCase). `Content-Encoding: gzip` is accepted.
- Auth header: `x-yuktiops-key: yk_otel_...` (a **telemetry key**, section 3). Install keys (`yk_live_...`) are rejected here and telemetry keys are rejected by `/v1/register`. Wrong or missing key: `401`; repeated wrong keys from one IP are throttled (`429`).
- Standard SDK env vars work unchanged: `OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.yuktiops.com` and `OTEL_EXPORTER_OTLP_HEADERS=x-yuktiops-key=yk_otel_...` (the SDK appends `/v1/traces` etc.).
- **Path choice.** OTLP uses the standard paths on the same API process; they do not collide with the agent protocol (`/v1/register`, `/v1/install-events`, `/v1/config`, `/v1/ingest`), and the two are separated by path *and* by credential type (`x-yuktiops-key` vs `Authorization: Bearer yk_live_...`). `otlp.yuktiops.com` is just another host name routed to the same upstream by the edge, so no Host-based routing exists in the app. In dev use `http://localhost:4000`.
- Limits: max body `4 MiB` after gunzip (`413`; configurable `OTEL_MAX_BODY_BYTES`); `1200` requests/minute per key (`429` + `Retry-After`).

### Responses

- `200` accepted. JSON requests get `{ "partialSuccess": { "rejectedSpans": "0" } }` (logs: `rejectedLogRecords`, metrics: `rejectedDataPoints`). Protobuf requests get a protobuf `Export*ServiceResponse`. When parts were dropped (a malformed span, sampling is **not** counted as a drop) `rejected*` is the count and `errorMessage` says why.
- `/v1/metrics`: always `200` with `rejectedDataPoints` = number of data points and `errorMessage: "Metrics are not stored yet."` (counted in usage, nothing kept).
- `400` body cannot be decoded. `401` bad/missing/revoked key. `402/403` the organization has no active subscription. `413` too large. `415` unsupported content type.
- `429` over the plan's monthly telemetry volume (or per-key request rate). Headers: `Retry-After: <seconds until the month ends | window end>`; body `{ "error": "...", "code": "quota_exceeded" | "rate_limited" }`. Exporters treat 429 as retryable.
- `503` the ingest queue is backed up; `Retry-After: 5`. Exporters retry.
- Accepted batches go to a BullMQ `otel` queue and are written by the `otel` worker role within seconds (1 minute at most under load).

### Monthly volume (GB per plan, per calendar month UTC)

| Plan | Free | Starter | Pro | Business |
|---|---|---|---|---|
| Included | 1 GB | 10 GB | 50 GB | 250 GB |
| Retention | 3 days | 7 days | 15 days | 30 days |

Counted as uncompressed request bytes (the quota table is code, `services/otel-usage.js`; there is no plan column for it yet) (traces + logs + metrics). Email to the organization owner at 80% and at 100% (once each per month). At 100% new data is refused with `429` until the month rolls over or the plan changes.

### What is stored

- Traces: one row per span. Logs: one row per record. Redaction rules (section 5) run on the worker **before** insert.
- Retention is applied per row at insert time from the plan at that moment; later plan changes do not rewrite old rows. Reads are clamped to the current plan's retention.
- Per-service RED rollups (rate, errors, p50/p95/p99 per minute) are materialized from spans that are entry points (`SpanKind` server/consumer, or no parent).

## 2. Connection status ("Waiting for your first trace...")

### GET /api/apps/connection

```json
{
  "otlpEndpoint": "https://otlp.yuktiops.com",
  "header": "x-yuktiops-key",
  "anyTraceSeen": true,
  "keys": [
    { "id": "uuid", "name": "production", "prefix": "yk_otel_ab12", "createdAt": "...",
      "lastSeenAt": "2026-11-16T10:00:00.000Z", "lastSignal": "traces", "traceSeen": true }
  ]
}
```

`lastSeenAt` / `lastSignal` (`traces|logs|metrics`) come from Redis and update on every accepted request (not when the worker stores it). `traceSeen` is true once that key ever delivered a traces request (kept 90 days). Poll this every 2-3 seconds. `keys` lists active telemetry keys only (empty array when none, which the page treats as "create a key first").

Hints the page can show when nothing arrives: no key yet; key exists but `lastSeenAt` is null (wrong endpoint, firewall, TLS or wrong key: the request never got an accepted response); `lastSeenAt` set but `traceSeen` false (logs only, no traces).

## 3. Telemetry ingest keys (Settings -> API keys)

Same hash/show-once model as the install key (`ApiKey.kind = 'telemetry'`, prefix `yk_otel_`). Write-only: they can only send OTLP. Admin only. Up to 20 active keys per organization; create one per environment (name it `production`, `staging`...).

- `GET /api/telemetry-keys` -> `{ "items": [ { "id", "name", "prefix", "createdAt", "lastUsedAt", "lastSeenAt" } ] }` (active keys only).
- `POST /api/telemetry-keys` `{ "name": "production" }` -> `201 { id, name, prefix, createdAt, key: "yk_otel_..." }`. The raw `key` appears only in this response.
- `DELETE /api/telemetry-keys/:id` -> `200 { "revoked": true }`. Takes effect for OTLP within seconds on every API instance. `404` for an unknown or already revoked key.

The existing `/api/api-key` endpoints keep managing only the single install key and never touch telemetry keys.

## 4. Dashboard queries

Common query params:

- `range`: `15m | 1h | 6h | 24h | 3d | 7d | 15d | 30d` (default `1h`), or explicit `from` and `to` (ISO). The window is clamped to the plan's retention; responses include `from`, `to` and `clamped: true` when that happened.
- Trace/log lists: `limit` (default 50, max 200), `before` (ISO timestamp of the last item you have, for the next page).

### GET /api/apps/services

Query: `range`.

```json
{
  "range": "1h", "from": "...", "to": "...", "clamped": false, "bucketSeconds": 300,
  "items": [
    {
      "name": "checkout-api",
      "status": "healthy",
      "requests": 1200, "ratePerSecond": 0.33,
      "errors": 6, "errorPercent": 0.5,
      "p50Ms": 12.4, "p95Ms": 80.1, "p99Ms": 240,
      "lastSeen": "2026-11-16T10:00:00.000Z",
      "hasTraces": true, "hasLogs": true,
      "sparkline": [ { "t": "2026-11-16T09:00:00.000Z", "requests": 100, "errors": 1, "p95Ms": 75.2 } ]
    }
  ]
}
```

`status`: `failing` (error % >= 5), `degraded` (error % >= 1), `idle` (no entry spans for 10 minutes), else `healthy`. Services that only sent logs appear with `hasTraces: false`, zeros and `status: "idle"`. `sparkline` has one point per bucket, empty buckets filled with zeros (`p95Ms: null`). Sorted by `requests` desc.

### GET /api/apps/services/:name

Query: `range`. `404` if the service has no data in the window or logs.

```json
{
  "service": { "...same fields as a list item, without sparkline" },
  "bucketSeconds": 60,
  "series": [ { "t": "...", "requests": 10, "ratePerSecond": 0.17, "errors": 1, "errorPercent": 10, "p50Ms": 5, "p95Ms": 40, "p99Ms": 90 } ],
  "topEndpoints": {
    "slowest": [ { "endpoint": "GET /orders/:id", "requests": 50, "errors": 0, "errorPercent": 0, "avgMs": 30, "p95Ms": 120 } ],
    "mostErrors": [ { "endpoint": "POST /pay", "requests": 20, "errors": 5, "errorPercent": 25, "avgMs": 60, "p95Ms": 200 } ]
  },
  "errors": [
    { "type": "TypeError", "message": "x is undefined", "count": 7, "lastSeen": "...", "sampleTraceId": "32hex" }
  ]
}
```

`endpoint` is the span name of entry spans (usually `METHOD /route`). `errors` groups exception events (`exception.type`) from error spans, and falls back to the span's status message / name when no exception event exists (`type: "Error"`). Max 10 rows per list. A page's "View traces" link is `/api/apps/traces?service=<name>`.

### GET /api/apps/traces

Query (all optional): `service`, `endpoint` (exact span name), `status` (`ok|error`), `minDurationMs` (trace duration), `attribute=key=value` (repeatable, max 5; matches span attributes or resource attributes of any span in the trace), `range`/`from`/`to`, `limit`, `before`.

```json
{
  "items": [
    { "traceId": "32hex", "startTime": "...", "durationMs": 123.4, "rootService": "checkout-api",
      "rootName": "GET /orders", "spanCount": 12, "errorCount": 1, "services": ["checkout-api", "db-proxy"] }
  ],
  "hasMore": false
}
```

Newest first. A trace matches when any of its spans in the window matches all the span filters (`service`, `endpoint`, `status=error`, `attribute`); `minDurationMs` applies to the whole trace and `status=ok` means no span of the trace failed. When only `service` (or nothing) is given, the trace is found through its entry spans for speed (a service that only has client/internal child spans in another service's trace is not listed). At most the 1000 most recent matching traces are considered. `rootService`/`rootName` come from the span without a parent (the earliest span when the root is missing).

### GET /api/apps/traces/:traceId

`404` when unknown for this organization.

```json
{
  "traceId": "32hex", "startTime": "...", "durationMs": 123.4, "spanCount": 12, "errorCount": 1,
  "spans": [
    { "spanId": "16hex", "parentSpanId": "16hex|null", "name": "GET /orders", "service": "checkout-api", "kind": "server",
      "startTime": "...", "startOffsetMs": 0, "durationMs": 123.4,
      "status": "ok", "statusMessage": "",
      "attributes": { "http.method": "GET" }, "resourceAttributes": { "service.name": "checkout-api" },
      "scope": "@opentelemetry/instrumentation-http",
      "events": [ { "time": "...", "offsetMs": 12.5, "name": "exception", "attributes": { "exception.type": "TypeError" } } ],
      "links": [ { "traceId": "...", "spanId": "...", "attributes": {} } ] }
  ],
  "logs": [ { "timestamp": "...", "severity": "error", "severityNumber": 17, "service": "checkout-api", "body": "...", "spanId": "16hex", "attributes": {} } ]
}
```

`spans` are ordered by start time (the waterfall draws `startOffsetMs` and `durationMs`); `status` is `unset|ok|error`; `kind` is `internal|server|client|producer|consumer|unspecified`. `logs` are the related log records of the trace (max 200, oldest first).

### GET /api/apps/logs

Query (all optional): `q` (text search: whitespace-separated terms, each must appear in the body, case-insensitive substring match, max 5 terms), `service`, `severity` (minimum level: `trace|debug|info|warn|error|fatal`), `traceId`, `attribute=key=value` (repeatable, max 5, log or resource attributes), `range`/`from`/`to`, `limit`, `before`, `after`.

```json
{
  "items": [
    { "id": "seq", "timestamp": "...", "severity": "error", "severityNumber": 17, "service": "checkout-api",
      "body": "payment failed", "traceId": "32hex|null", "spanId": "16hex|null",
      "attributes": { "order.id": "42" }, "resourceAttributes": { "service.name": "checkout-api" } }
  ],
  "hasMore": false,
  "cursor": "1763287200123456"
}
```

Newest first by log timestamp. **Live tail:** call once normally, keep `cursor`, then poll every 1-2 s with `after=<cursor>` (ignores `before`/range start): the response contains only records stored after that cursor (still newest first, max 500) and a new `cursor`; if nothing is new the same cursor comes back. The cursor is opaque (an ingest sequence), not a timestamp; clients that send logs with old timestamps still show up in the tail.

## 5. Telemetry settings

### GET /api/apps/settings

```json
{
  "redaction": {
    "rules": [
      { "id": "r1", "type": "attribute", "key": "http.request.header.authorization", "action": "drop" },
      { "id": "r2", "type": "pattern", "preset": "email", "action": "mask" }
    ]
  },
  "sampling": { "tracesRatio": 1, "keepErrors": true, "keepSlowMs": null, "logsMinSeverity": "trace" },
  "retention": { "days": 7, "plan": "starter", "byPlan": { "free": 3, "starter": 7, "pro": 15, "business": 30 } },
  "usage": {
    "month": "2026-11", "bytes": 123456, "limitBytes": 10737418240, "percent": 0.001,
    "bySignal": { "traces": 100000, "logs": 23456, "metrics": 0 },
    "resetsAt": "2026-12-01T00:00:00.000Z"
  },
  "otlpEndpoint": "https://otlp.yuktiops.com"
}
```

### PUT /api/apps/settings (admin)

Body: `{ "redaction": { "rules": [...] }, "sampling": { ... } }` (either part optional; `redaction.rules` replaces the stored list, `sampling` fields are merged into the stored settings). Returns the same shape as GET. `400` with a message on invalid input.

Redaction rules (max 50), applied to every attribute (resource, span, event, link, log) and to log bodies, span names and status messages, **before** storage:

- `{ "type": "attribute", "key": "<name>", "action": "drop" | "hash" }`: `key` is matched case-insensitively against the attribute name; a trailing `*` makes it a prefix match (`http.request.header.*`). `drop` removes the attribute; `hash` replaces the value with `sha256:<16 hex>` (stable per organization, so values can still be correlated).
- `{ "type": "pattern", "preset": "email" | "credit_card" | "ipv4" | "jwt" | "bearer", "action": "mask" | "hash" }`: finds the pattern inside string values and bodies and replaces each hit with `[REDACTED:<preset>]` (`mask`) or `sha256:<16 hex>` (`hash`). Only these presets exist (no custom regex, to rule out slow patterns).
- Rules take effect for batches processed after the save (within seconds). `id` is optional on input; the server assigns ids.

Sampling:

- `tracesRatio` 0..1 (default 1). Trace-level and deterministic from the trace id, so all spans of a trace are kept or dropped together within a batch.
- `keepErrors` (default true): traces containing an error span are kept regardless of the ratio. `keepSlowMs` (null or ms): traces with a span slower than this are kept.
- `logsMinSeverity` (`trace|debug|info|warn|error|fatal`, default `trace`): lower severities are dropped.
- Sampled-out data still counts toward the monthly volume (it was received).

`retention` is read-only: it follows the plan.

## 6. Alerts

Three new metric sources of kind `app` (subjects are service names; `scope: { "type": "selected", "ids": ["checkout-api"] }` selects services by name), listed by `GET /api/alerts/metrics` and `/api/alerts/templates`:

| metric | Template key | Default | Meaning |
|---|---|---|---|
| `app_error_rate` | `app_error_rate` | `gt 5` (%), 5 min | Every minute with traffic in the window has more than 5% failed entry requests |
| `app_latency_p95` | `app_latency_p95` | `gt 1` (seconds), 5 min | The p95 of each minute in the window is above 1 s |
| `app_no_traces` | `app_no_traces` | `gt 10` (minutes), 0 | A service seen before sent no spans for 10 minutes |

`available` is true once the organization has a telemetry key. Incidents are named "<rule> on <service>".

## Operations

- ClickHouse settings: `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_DATABASE`. Schema migrations: `backend/clickhouse/migrations/*.sql`, run automatically by the `otel` worker role at start and by `npm run ch:migrate -w backend`.
- Worker role: `node backend/src/worker.js --role=otel` (health port 9106); `--role=all` includes it.
- `OTLP_PUBLIC_URL` (default `API_PUBLIC_URL`) is what the dashboard shows as the endpoint.
