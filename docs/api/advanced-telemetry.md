# Advanced telemetry contract (premium dashboard, container logs, DB credentials, platform admin)

This is the shared contract between the agent (Go), the backend and the frontend. If a part needs to change, change it here first.

## 1. Plan features
- `SubscriptionPlan.features Json @default("{}")`.
  - `pro` and `business` get `{"advancedDashboard": true, "promMetrics": true}`.
  - `free` and `starter` get `{}`.
- Helper: `hasFeature(plan, name)` in `backend/src/services/limits.js`.
- Bootstrap (`GET /api/bootstrap`) returns `plan.features`. The frontend reads it from `useSession().plan.features`.

## 2. Agent settings (additions to `agentSettingsSchema` in `backend/src/services/agent-config.js` and `remote.Settings` in `agent/internal/remote/settings.go`)

Both sides are strict. Add every field on **both** sides with these defaults:

```jsonc
{
  "collectors": {
    // ...existing fields...
    "prometheus": false,             // set by the backend from plan.features.promMetrics. Users cannot change it.
    "containerLogs": {               // all plans. Logs count against the telemetry quota.
      "enabled": false,
      "include": [],                 // container names. Empty means every running container.
      "exclude": []                  // container names to skip. The Docker label yuktiops.logs=false also skips.
    }
  },
  "prometheus": {                    // only used when collectors.prometheus is true
    "path": "/v1/prom/write",        // relative to the agent's API base URL
    "scrapeIntervalSeconds": 15      // 15..60
  }
}
```
Service entries (`collectors.services[]`) gain:
- An optional `"credentialsRef": "redis-main"`, matching `^[a-z0-9][a-z0-9-]{0,39}$`.
- The kind **`mssql`** (default port 1433).

### Plan changes
`onPlanChanged(store, orgId)` in `agent-config.js`:
1. Sets `collectors.prometheus = hasFeature(plan, 'promMetrics')` on every agentConfig of the org.
2. Bumps `version`.
3. Publishes `CHANNELS.agentInvalidate`.

`GET /v1/config` also returns a top-level `"plan": {"name": "Pro"}` (null name when there is no valid subscription), so the agent can log the plan name. The served `collectors.prometheus` and `prometheus.path` always follow the plan, whatever the stored profile says.

It is called by billing plan changes, `downgradeToFree`, dunning, and the platform admin's "change plan". The agent picks up the new version on its next ingest reply (30 s or less). It starts or stops collectors **without a restart** and logs `Advanced metrics on (plan <name>)` or `Advanced metrics off`.

## 3. Metrics: Prometheus remote_write
- `POST /v1/prom/write` takes standard remote_write v1: `Content-Encoding: snappy`, `Content-Type: application/x-protobuf`, `X-Prometheus-Remote-Write-Version: 0.1.0`.
- It authenticates with the agent's existing credential, the same as `/v1/ingest`.
- The agent hand-encodes the protobuf and compresses it with snappy (block format, as remote_write v1 requires) and sends at most 5 000 series per request.
- Series without `__name__`, with invalid label names or with 40+ labels are dropped (the rest of the batch is accepted). The 429 body carries `code`: `rate_limited`, `overloaded`, `series_limit` or `sample_limit`, with `Retry-After`.
- Responses:

| Status | Meaning |
|---|---|
| 202 | Accepted |
| 400 | Bad payload |
| 401 | Bad credential |
| 402 | Org not entitled. The agent turns the collector off until its settings say otherwise. |
| 403 | Org suspended |
| 413 | Body over 4 MB |
| 429 | Back-pressure or cardinality cap. The agent backs off. |

### Labels the agent sets
| Label | Value |
|---|---|
| `job` | `node` for node metrics. `cadvisor` for container metrics. `redis`, `mysql`, `postgres` or `mssql` for DB metrics. |
| `instance` | `<agentId>` |
| `nodename` | the host name |

DB metrics also carry `service=<service name>`.

### Labels the backend sets
- It **always removes** any `yk_*` labels the agent sent, then adds `yk_org=<orgId>` and `yk_agent=<agentId>`.
- Per-org cap: 50k active series by default (`PROM_MAX_SERIES_PER_ORG`).

### Metric names
- **Node:** node_exporter names, as in `refference.json` (`node_cpu_seconds_total`, `node_memory_*_bytes`, `node_disk_*`, `node_filesystem_*`, `node_network_*`, `node_sockstat_*`, `node_netstat_*`, `node_softnet_*`, `node_arp_entries`, `node_nf_conntrack_*`, `node_filefd_*`, `node_load*`, `node_pressure_*`, `node_schedstat_*`, `node_forks_total`, `node_procs_*`, `node_processes_*`, `node_time_seconds`, `node_boot_time_seconds`, `node_uname_info`, `node_vmstat_*`).
- **Containers** (sent only when `collectors.docker` is also true): cAdvisor names with label `name`:
  - `container_cpu_usage_seconds_total`
  - `container_memory_working_set_bytes`
  - `container_spec_memory_limit_bytes`
  - `container_network_receive_bytes_total`
  - `container_network_transmit_bytes_total`
  - `container_start_time_seconds`
  - `container_last_seen`
- **Databases:** exporter-compatible names (`redis_*`, `mysql_global_status_*`, `pg_*`, `mssql_*`), sent only when credentials are configured.

### Storage
VictoriaMetrics single-node, compose service `victoriametrics`, `-retentionPeriod=30d`. The backend reaches it at `VM_URL` (default `http://localhost:8428`).

## 4. Dashboard API (session auth, org scoped, 402 when `advancedDashboard` is missing)
- `GET /api/dashboards/presets` returns `[{id:"node-exporter-full", title, description}]`.
- `GET /api/dashboards/presets/:id` returns the preset document (below).
- `GET /api/dashboards/query_range?query=&start=&end=&step=` and `GET /api/dashboards/query?query=&time=` are proxied to VictoriaMetrics with `extra_label=yk_org=<orgId>`.
  - The response is the Prometheus HTTP API shape: `{status, data:{resultType, result:[{metric:{}, values:[[ts,"v"]]}]}}`.
  - Limits: step floor 15 s (a smaller or missing step is raised; a step giving more than 11 000 points per series is widened), a 10 s timeout, and 300 requests per minute per user (query and query_range together).
  - Errors: 400 `bad_query`, 402 not entitled, 429 `rate_limited`, 503 `metrics_unavailable`, 504 `query_timeout`.
- `GET /api/dashboards/targets` returns `[{agentId, name, os, hasData}]`, the hosts that have sent remote_write data.

### Preset document
`backend/src/dashboards/node-exporter-full.json` is generated from `refference.json` by `backend/scripts/import-grafana.mjs`:

```jsonc
{
  "id": "node-exporter-full",
  "title": "Node Exporter Full",
  "variables": ["node", "container"],          // node = agentId (instance label); container = name label regex
  "rows": [
    { "title": "Quick CPU / Mem / Disk", "collapsed": false,
      "panels": [
        { "id": "panel-20", "title": "CPU Busy", "type": "gauge",     // timeseries|stat|gauge|bargauge|table|piechart
          "grid": { "x": 0, "y": 0, "w": 3, "h": 4 },
          "unit": "percent", "decimals": 1, "min": 0, "max": 100,
          "thresholds": [{ "value": null, "color": "green" }, { "value": 85, "color": "red" }],
          "stacking": false, "fill": 10,
          "targets": [{ "expr": "100 * (1 - avg(rate(node_cpu_seconds_total{mode=\"idle\",instance=\"$node\",job=\"node\"}[$__rate_interval])))", "legend": "{{mode}}", "instant": true }]
        }
      ] }
  ]
}
```
- `$job` is replaced by `node` and `$cadvisor_job` by `cadvisor`.
- `$node`, `$container`, `$__rate_interval`, `$__interval` and `$__range` are replaced by the frontend.
- Every cAdvisor selector (`job="cadvisor"`) also carries `instance="$node"`, so containers of different hosts never mix.
- `stacking` is `false`, `"normal"` or `"percent"`. Optional extras a renderer may use: `description`, `thresholdsMode`, `colorMode`, `mappings`, `overrides`, `options` (Grafana panel options), `transformations`; targets may carry `refId` and `format: "table"`. Hidden Grafana queries are dropped.

## 5. Container logs
- **Agent → backend:** OTLP/HTTP **JSON** logs to the existing OTLP logs ingest, `POST /v1/otlp/logs` on the agent API base, with the **agent credential**. The backend maps it to the org and counts the bytes against `otel-usage.js`.
  - The agent sends the JSON gzip-compressed (`Content-Encoding: gzip`); the body limit (4 MB) applies after decompression.
  - The bearer agent credential also works on the standard `POST /v1/logs`. The backend overwrites `yk.agent` with the authenticated agent id.
  - Resource attributes:
    - `service.name` is the container name.
    - `container.name`, `container.id`, `container.image` and `host.name`.
    - `yk.agent` is the agentId.
    - `yk.source` is `docker`.
  - Log record attributes: `log.iostream` (`stdout` or `stderr`). `severityText` is guessed from the line (`ERROR`, `WARN`, `INFO`, `DEBUG`, or empty).
  - Limits: lines are capped at 16 KB, batches at 1 MB or 2 s, and each container at 1 000 lines/s (the rest are dropped and counted).
  - **429 means the quota is exhausted.** The agent pauses logs only, for 5 minutes, and reports the error code `logs_quota`.
- **API:** `GET /api/containers/:id/logs?since=&until=&q=&level=&stream=&limit=200` returns `{items:[{time, stream, level, message}], nextSince}`. Times are ISO strings; `limit` is 1000 at most.
  - `items` are oldest first. Without `since`: the newest `limit` lines. With `since` (exclusive): the next `limit` lines after it (live tail). `nextSince` is the newest item's time with nanoseconds; pass it back as `since`.
  - `level` is `error|warn|info|debug` (output: the same words, or empty); `stream` is `stdout|stderr`. ClickHouse down: 503 `telemetry_unavailable`.
  - `GET /api/containers/:id` includes `logsEnabled` (whether the agent's settings collect this container).
- **Settings:** `PATCH /api/containers/:id/logs {enabled:boolean}` (editors) adds the container name to `containerLogs.include`, or adds it to `exclude`, and sets `enabled:true` when needed. Turning off the last name in a non-empty `include` switches collection off. Returns `{enabled, containerLogs}`.

## 6. Database credentials (never sent to YuktiOps)
- A service entry carries only `credentialsRef`.
- **Where the agent looks for the secret,** in order:
  1. The environment variables `YUKTIOPS_CRED_<REF>_URL`, or `YUKTIOPS_CRED_<REF>_USER` together with `_PASSWORD` (plus optional `_DATABASE` and `_SSLMODE`). `<REF>` is upper-cased, with `-` replaced by `_`.
  2. The file `<configDir>/credentials.d/<ref>.env` with the keys `URL`, `USER`, `PASSWORD`, `DATABASE` and `SSLMODE`. On Unix the file must be mode 0600 or stricter; otherwise the detail is `credentials file must be 0600`.
- **Status detail strings** (never the secret): `authenticated`, `auth failed: wrong user or password`, `credentials not found`, `responding (password required)`.
- **Least-privilege user per kind** (shown in the UI):
  - Redis: `ACL SETUSER yuktiops on >PASS +ping +info +client|list`
  - MySQL: `CREATE USER 'yuktiops'@'%' IDENTIFIED BY 'PASS'; GRANT PROCESS, REPLICATION CLIENT ON *.* TO 'yuktiops'@'%';`
  - Postgres: `CREATE ROLE yuktiops LOGIN PASSWORD 'PASS'; GRANT pg_monitor TO yuktiops;`
  - MSSQL: `CREATE LOGIN yuktiops WITH PASSWORD='PASS'; GRANT VIEW SERVER STATE TO yuktiops;`
- **MSSQL liveness:** a TDS PRELOGIN packet (type `0x12`). Any TDS reply (type `0x04`) means running. No credentials are needed.

## 7. Platform admin
- **Schema:**
  - `User.isPlatformAdmin Boolean @default(false)` and `User.disabledAt DateTime?`.
  - `Organization.suspendedAt DateTime?` and `Organization.suspendReason String?`.
  - A `PlatformAuditLog` table with `id, adminUserId, action, targetType, targetId, details Json, createdAt`.
- **Auth:** `/api/auth/me` returns `isPlatformAdmin`. All admin routes live under `/api/platform/*` and return 403 unless the user is a platform admin.
- **Suspended orgs:**
  - The org API returns `423 {error:"This organization is suspended."}`, except `/api/bootstrap`, which includes `organization.suspendedAt`.
  - Agent `/v1/*` returns 403.
- **Routes:**
  - `GET /overview` returns `{totals:{orgs, users, activeAgents, monitors}, orgsByPlan:[{planId,count}], mrrCents, signupsByDay:[{day,count}], health:{...}}`.
  - `GET /orgs?q=&plan=&status=active|suspended&page=&pageSize=` returns `{items, total}`.
  - `GET /orgs/:id`
  - `POST /orgs/:id/plan {planId, periodEnd?, note?}`
  - `POST /orgs/:id/suspend {reason}`
  - `POST /orgs/:id/reactivate`
  - `GET /users?q=&page=`
  - `POST /users/:id/disable` and `POST /users/:id/enable`
  - `GET /audit?page=`
- **CLI:** `npm run admin:create -- <email> [--password <pw>]` and `npm run admin:revoke -- <email>`.
