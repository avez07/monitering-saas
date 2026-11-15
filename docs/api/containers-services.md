# Containers and Services API (Phases 11 and 12, implemented)

Cookie-authenticated (`/api`), read-only: any member including `viewer` can read; there are no write routes
(data comes from the agent, what to watch is set in the server's agent settings, see
`docs/api/agent-ingest-extensions.md`). Errors are `{ "error": "..." }` (400 bad query, 401, 404).
Lists are always `{ "items": [...], "summary": {...} }`. Rows from removed servers are never returned.
Ids are opaque strings.

## GET /api/containers

Query (all optional): `serverId` (agent id), `state` (`running|restarting|paused|stopped|removed|all`, default = everything except `removed`), `q` (name contains).

```json
{
  "items": [
    {
      "id": "uuid", "serverId": "agent-uuid", "serverName": "web-1",
      "name": "web", "image": "nginx:1.27",
      "state": "running", "statusText": "Up 3 hours", "restarts": 0,
      "cpuPercent": 1.2, "memoryBytes": 52428800, "memoryLimitBytes": 536870912,
      "startedAt": "2026-11-15T07:00:00.000Z",
      "firstSeen": "...", "lastSeen": "...", "stateChangedAt": "..."
    }
  ],
  "summary": { "running": 3, "restarting": 0, "paused": 0, "stopped": 1, "removed": 0, "total": 4 }
}
```

- `state`: `running` | `restarting` | `paused` | `stopped` (exited, created, dead) | `removed` (gone from the server for 5+ minutes; kept 7 days). `summary.total` excludes `removed`; `summary` ignores the filters except the org.
- `cpuPercent` / `memoryBytes` are null unless running. `memoryLimitBytes` is null when unlimited.

## GET /api/containers/:id

The list item plus `events`: newest first, up to 50, `{ "id", "type", "message", "at" }`, `type` one of `appeared | started | stopped | restarted | oom | removed`.

## GET /api/containers/:id/metrics?range=1h|24h|7d

Default `1h`. `{ range, bucketSeconds, clamped, from, to, points }`; `1h` = raw samples (`bucketSeconds: null`), `24h` = 5-minute averages, `7d` = 1-hour averages. `clamped` is true when the plan's history (Free 7 days) is shorter than the range. Raw data is kept 8 days.

```json
{ "t": "...", "cpu": 1.2, "cpuMax": 3.0, "memoryBytes": 5e7, "memoryMaxBytes": 6e7, "memoryLimitBytes": 5e8, "restartCount": 0 }
```

## GET /api/services

Query (all optional): `serverId`, `kind` (`systemd|process|port|nginx|apache|mysql|postgres|redis`), `state` (`running|stopped|failed|unknown`), `q`.

```json
{
  "items": [
    {
      "id": "uuid", "serverId": "agent-uuid", "serverName": "web-1",
      "name": "nginx", "kind": "systemd", "type": "systemd",
      "state": "running", "detail": "active (running)", "responseMs": null, "port": null,
      "firstSeen": "...", "lastSeen": "...", "lastChecked": "...", "stateChangedAt": "..."
    }
  ],
  "summary": { "running": 4, "stopped": 1, "failed": 0, "unknown": 0, "total": 5 }
}
```

- `kind` is the exact collector; `type` is the display group: `web` (nginx, apache), `database` (mysql, postgres), `cache` (redis), otherwise the same as `kind`. `lastChecked` equals `lastSeen`.
- `detail` may be an empty string.
- A service the user removes from the server's config disappears 15 minutes after it was last reported.

## GET /api/services/:id

The list item plus `events` (same shape as containers; `type` one of `appeared | stopped | failed | recovered`).

## Alerts

Templates `container_stopped` and `service_stopped` (see `docs/api/alerts.md`) become `available: true` once any container / service has been reported. Both are per server: an incident is opened when at least one container that was seen running (or any configured service) is reported not running in 2 consecutive ingests; `value` is the number stopped, and the notification names them. Scope `all` or `selected` servers works as for other server rules.
