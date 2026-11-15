# Servers API

All routes are cookie-authenticated (`/api`, header `X-Organization-Id` optional), CSRF-guarded on writes.
Errors are always `{ "error": "plain message" }` with the HTTP status (400 validation, 401 signed out, 403 role, 404 not found).
A "server" is identified by its **agent id** (`id`). `resourceId` is the matching `MonitoredResource` id (used by the older `DELETE /api/resources/:id`).

Roles: any member can read; `owner` and `admin` can PATCH / DELETE. `viewer` gets 403 on writes.

## GET /api/servers

```json
[
  {
    "id": "agent-uuid",
    "resourceId": "uuid",
    "name": "web-1",
    "hostname": "ip-10-0-0-5",
    "os": "Ubuntu 24.04",
    "arch": "amd64",
    "platform": "linux",
    "agentVersion": "0.1.0",
    "status": "online",
    "lastSeen": "2026-11-15T10:00:00.000Z",
    "cpu": 12.3,
    "memory": 40.1,
    "disk": 55.0,
    "uptimeSeconds": 86400,
    "cores": 4,
    "ramGb": 16
  }
]
```

- `name` is the editable display name; `hostname` is the name the agent registered with.
- `status`: `online` | `offline` | `never_connected`. `online` = last data within max(90 s, 3 x send interval). `never_connected` = registered but no data yet (`lastSeen` is null).
- `cpu/memory/disk` = latest percent, null if unknown. Removed servers are not listed.

## GET /api/servers/:id

Everything in the list item plus:

```json
{
  "latest": {
    "time": "...",
    "cpu": 12,
    "memory": 40,
    "swap": 0,
    "disk": 55,
    "load": [0.1, 0.2, 0.3],
    "netRxBps": 1000,
    "netTxBps": 500,
    "diskReadBps": 0,
    "diskWriteBps": 0,
    "uptimeSeconds": 100
  },
  "disks": [{ "path": "/", "percent": 55, "totalBytes": 1e11, "usedBytes": 5e10 }],
  "interfaces": [{ "name": "eth0", "rxBps": 1000, "txBps": 500 }],
  "processes": [{ "name": "node", "pid": 12, "cpu": 3.2, "memBytes": 1e8 }],
  "config": {
    "id": "st_...",
    "name": "Default",
    "version": 1,
    "isDefault": true,
    "shared": true,
    "settings": { "sendIntervalSeconds": 30, "sampleIntervalSeconds": 10, "collectors": { "cpu": true } }
  },
  "createdAt": "..."
}
```

`latest` is null (and `disks/interfaces/processes` are `[]`) before the first data.

## GET /api/servers/:id/metrics?range=1h|24h|7d|30d

Source by range: `1h` raw samples, `24h` 5-minute aggregate, `7d` and `30d` 1-hour aggregate. The range is clamped to the plan's retention (Free = 7 days); then `clamped: true` and `from` is the real start. Default range `24h`.

```json
{
  "range": "24h",
  "source": "5m",
  "bucketSeconds": 300,
  "clamped": false,
  "from": "...",
  "to": "...",
  "points": [
    {
      "t": "2026-11-15T09:55:00.000Z",
      "cpu": 12, "cpuMax": 30,
      "memory": 40, "memoryMax": 41,
      "swap": 0,
      "load1": 0.2, "load5": null, "load15": null,
      "disk": 55,
      "netRxBps": 1000, "netTxBps": 500,
      "diskReadBps": 0, "diskWriteBps": 0
    }
  ]
}
```

Points are ascending; every point has every key (null when absent). `load5/load15` exist only for raw (`1h`). `bucketSeconds` is null for raw. Gaps (agent offline) are simply missing points.

## PATCH /api/servers/:id (admin+)

Body, any of: `{ "name": "Database 1", "config": { "sendIntervalSeconds": 60, "sampleIntervalSeconds": 10, "collectors": { "cpu": true } } }`

`config` is the full settings object (same schema as `/api/agent-configs`). The server gets its **own** setup profile (copy-on-write if it was on the shared default or a shared profile) with the version bumped so the agent picks it up. Returns the same object as `GET /api/servers/:id`.

## DELETE /api/servers/:id (admin+)

204. Removes the server and revokes its agent credential (same effect as `DELETE /api/resources/:id`).
