# Connection status API

## GET /api/servers/:id/connection

Any member. `:id` is the agent id.

```json
{
  "server": { "id": "...", "name": "web-1", "status": "online" },
  "overall": "connected",
  "lastDataAt": "...",
  "lastDataSecondsAgo": 12,
  "steps": [
    { "key": "install_started", "title": "Install started", "state": "done", "detail": "..." },
    { "key": "registered", "title": "Agent installed and registered", "state": "done", "detail": "..." },
    { "key": "running", "title": "Agent running", "state": "done", "detail": "..." },
    { "key": "data", "title": "Data arriving", "state": "done", "detail": "Last data 12 seconds ago", "secondsAgo": 12 },
    { "key": "problems", "title": "Problems reported", "state": "done", "detail": "No problems reported." }
  ],
  "problems": [],
  "events": [
    {
      "id": "...",
      "at": "...",
      "source": "install",
      "code": "clock_skew",
      "message": "raw text from the agent or server",
      "details": {},
      "title": "Your server's clock is wrong",
      "explanation": "...",
      "severity": "warning",
      "fix": { "summary": "...", "commands": ["sudo timedatectl set-ntp true"] }
    }
  ],
  "installTimeline": [],
  "diagnosis": null,
  "commands": {
    "status": "yuktiops-agent status",
    "restart": "sudo systemctl restart yuktiops-agent",
    "logs": "sudo journalctl -u yuktiops-agent -f",
    "doctor": "sudo yuktiops-agent doctor",
    "uninstall": "sudo yuktiops-agent uninstall"
  }
}
```

- Step `state`: `done | current | waiting | failed`.
- `overall`: `connected` (fresh data, no problems), `problem` (problems exist or a step failed), `waiting` (install in progress), `silent` (registered or installing, but nothing heard for 2+ minutes).
- `events`: newest first, max 50; `source` is `install | agent | server`; `severity` is `info | warning | error`.
- `problems`: the latest event per problem code in the last hour (same shape as events).
- `installTimeline`: install-source events, oldest first.

When `overall` is `silent`, `diagnosis` is set (honest: we cannot hear this server, so we cannot see why):

```json
{
  "kind": "no_data",
  "title": "We can't hear from this server yet",
  "explanation": "...",
  "checklist": [{ "text": "Outbound HTTPS (port 443) to the API must be allowed", "command": "curl -I https://api.yuktiops.com/health" }],
  "doctorCommand": "sudo yuktiops-agent doctor"
}
```

## GET /api/connection/pending

For the Add-server wizard before any server exists: install events not yet attached to a server (last 2 hours) for this organization.

```json
{
  "steps": [],
  "events": [],
  "serverId": null,
  "diagnosis": null
}
```

`serverId` is set once a server has registered in the last 2 hours (jump to its connection page). `diagnosis` appears after 3 minutes of silence following an install start.

## Error catalog codes

Server-detected: `credential_revoked` (401), `plan_limit` (402 on register), `rate_limited` (429), `payload_too_large` (413), `server_removed` (403), `invalid_payload` (400), `clock_skew`.

Agent-reported: `https_unreachable`, `dns_failed`, `tls_failed`, `proxy_error`, `clock_skew`, `docker_socket_denied`, `disk_permission`, `processes_restricted`, `config_invalid`, `config_pull_failed`, `config_adjusted`, `buffer_full`, `buffer_write_failed`, `payload_rejected`, `send_failed`, `server_error`, `collector_failed_*`, `agent_error`. Anything else maps to `unknown` (the raw message is kept).

Install codes: `started downloaded verified installed registered service_started failed`.

Server-detected rejection events are de-duplicated: the same code is stored at most once per 5 minutes per server; max 50 events per server are kept.

`GET /api/connection/pending` also accepts an optional `?since=<ISO time>` (when the wizard opened): only servers registered after it count, and silence is measured from it when no install event has arrived.
