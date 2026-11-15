# Agent protocol: containers and services (Phases 11 and 12)

Extends `POST /v1/ingest` and the remote agent config. Everything here is optional: an agent that sends neither
field keeps working exactly as before. The agent never executes anything it receives; config only switches
**built-in, read-only collectors** on or off and names what to look at. No credentials are ever sent to or stored by us.

## Remote config (`GET /v1/config`, `settings`)

Two additions inside `settings.collectors` (validated by `agentSettingsSchema`; unknown keys are rejected):

```json
{
  "collectors": {
    "cpu": true,
    "docker": false,
    "services": [
      { "kind": "systemd", "name": "nginx" },
      { "kind": "process", "name": "php-fpm" },
      { "kind": "port", "name": "ssh", "port": 22, "host": "127.0.0.1" },
      { "kind": "nginx", "name": "nginx", "url": "http://127.0.0.1/nginx_status" },
      { "kind": "apache", "name": "apache", "url": "http://127.0.0.1/server-status?auto" },
      { "kind": "redis", "name": "redis", "host": "127.0.0.1", "port": 6379 },
      { "kind": "mysql", "name": "mysql", "host": "127.0.0.1", "port": 3306 },
      { "kind": "postgres", "name": "postgres", "host": "127.0.0.1", "port": 5432 }
    ]
  }
}
```

- `docker` (boolean, default **false**, opt-in): list containers through the local Docker socket (read-only API calls: list and stats).
- `services` (array, default `[]`, max 50). Each entry:

| field | rules |
| ----- | ----- |
| `kind` | `systemd` \| `process` \| `port` \| `nginx` \| `apache` \| `mysql` \| `postgres` \| `redis` |
| `name` | 1-100 chars, `[A-Za-z0-9 @._:/+-]`. systemd: the unit name (with or without `.service`). process: the process name to look for. Others: a display name. `(kind, name)` must be unique in the list. |
| `port` | 1-65535. Required for `port`; optional for mysql/postgres/redis (defaults 3306 / 5432 / 6379). |
| `host` | optional host name or IP, default `127.0.0.1`. Used by `port`, `mysql`, `postgres`, `redis`. |
| `url` | required for `nginx` (stub_status page) and `apache` (server-status page, `?auto` recommended). `http` or `https`, max 300 chars. |

How each kind is decided (all read-only, no credentials):

- `systemd`: `ActiveState` of the unit via the systemd D-Bus API or `systemctl show` (Linux only). `active` = running, `failed` = failed, `inactive`/`deactivating` = stopped, anything else / unit not found = unknown.
- `process`: running if a process with that name exists, else stopped.
- `port`: running if a TCP connect to `host:port` succeeds within 3 s, else stopped. `responseMs` = connect time.
- `nginx` / `apache`: running if the status URL returns 200 within 3 s. `detail` is a short summary (for example `12 active connections`). Failure = stopped.
- `redis`: TCP connect and `PING`; a `+PONG` or `-NOAUTH` reply counts as responding. `mysql`: TCP connect and the server greeting packet. `postgres`: TCP connect and an `SSLRequest` answered with `S` or `N`. Failure to connect = stopped. Deep database metrics need local secrets and are a later phase.

The agent reports the result of **every configured service on every send**, so the dashboard can show Stopped.

## Ingest payload additions

Both fields are top-level siblings of `samples`:

```json
{
  "sentAt": "2026-11-15T10:00:00Z",
  "agent": {},
  "samples": [],
  "containers": [
    {
      "id": "3f4a9c1b2d7e",
      "name": "web",
      "image": "nginx:1.27",
      "state": "running",
      "status": "Up 3 hours",
      "restartCount": 0,
      "cpuPercent": 1.4,
      "memoryBytes": 52428800,
      "memoryLimitBytes": 536870912,
      "startedAt": "2026-11-15T07:00:00Z",
      "oomKilled": false
    }
  ],
  "services": [
    { "name": "nginx", "kind": "systemd", "state": "running", "detail": "active (running)", "responseMs": null, "port": null }
  ]
}
```

Semantics:

- **Present means authoritative.** If `containers` is present (even `[]`) it is the complete snapshot of containers at `sentAt`. If it is absent the collector is off and stored containers are left alone. Same for `services`.
- Send the snapshot as of the **newest** sample time; send it once per ingest (not once per buffered sample). Snapshots with `sentAt` not newer than the last one processed for that server are ignored (retries are harmless).
- Containers are identified by **`name`** (unique per Docker host); `id` is the current Docker container id and may change when a container is recreated.
- Services are identified by `(kind, name)`.

### Container fields

| field | type | rules |
| ----- | ---- | ----- |
| `id` | string | 1-80 chars `[A-Za-z0-9_.-]` (short or full Docker id) |
| `name` | string | 1-200 chars, leading `/` is stripped |
| `image` | string | max 300 |
| `state` | string | Docker state: `running` \| `paused` \| `restarting` \| `exited` \| `created` \| `dead` \| `removing` |
| `status` | string | optional human text such as `Up 3 hours`, max 200 |
| `restartCount` | int | 0-1e9 |
| `cpuPercent` | number | optional, 0-100000 (percent of one core, as `docker stats`) |
| `memoryBytes`, `memoryLimitBytes` | number | optional, 0-1e16; limit 0/absent = unlimited |
| `startedAt` | RFC 3339 | optional, last start time |
| `oomKilled` | boolean | optional, from `State.OOMKilled` |

Limits: at most **100 containers** and **100 services** per ingest (the whole request body is capped at 512 KB). A request over a limit is rejected with 400 `invalid_payload` (recorded on the Connection page).

### Service fields

| field | type | rules |
| ----- | ---- | ----- |
| `name` | string | 1-100 chars |
| `kind` | string | `systemd` \| `process` \| `port` \| `nginx` \| `apache` \| `mysql` \| `postgres` \| `redis` |
| `state` | string | `running` \| `stopped` \| `failed` \| `unknown` |
| `detail` | string | optional, max 200 |
| `responseMs` | number | optional, 0-600000 |
| `port` | int | optional, 1-65535 |

## What the server does with it

- State is normalised to `running` / `restarting` / `paused` / `stopped` (exited, created, dead, removing) / `removed`.
- A container missing from a snapshot for 5 minutes (while the server keeps reporting) becomes `removed` (no alert; it was deleted on purpose). `removed` rows are dropped after 7 days. A configured service that disappears from the snapshot (removed from config) is dropped after 15 minutes.
- State changes are stored as events: `appeared`, `started`, `stopped`, `restarted` (restart count rose), `oom`, `removed`, `recovered` / `failed` (services).
- Per-ingest container CPU/memory is stored in the `container_metrics` hypertable (8 days raw; shorter plans trimmed hourly).
- Alerts ("Container stopped", "Service stopped", per server): a container that was seen running and is then not running in **2 consecutive ingests**, or a configured service reported `stopped`/`failed` in 2 consecutive ingests, opens an incident at the next alert evaluation (the worker evaluates every 30 seconds). It recovers after the item is `running` again (plus the normal 60 s recovery delay).

Read APIs for the dashboard: `docs/api/containers-services.md`.
