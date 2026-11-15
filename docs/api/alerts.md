# Alerts API

Cookie-authenticated (`/api`), CSRF-guarded on writes. Errors are `{ "error": "plain message" }` (400 validation, 402 plan limit, 403 role, 404).
Roles: any member can read; `owner` and `admin` can create/edit/delete rules and acknowledge/resolve incidents. `viewer` gets 403 on writes.
All lists return `{ "items": [...], ...meta }`.

The words `operator`, `threshold` and `severity` exist only in the API. The UI should show the `summary` sentence and plain controls.

## Metrics catalog

`GET /api/alerts/metrics`

```json
{ "items": [
  { "key": "disk", "label": "Disk space used", "kind": "server", "unit": "%", "available": true,
    "defaults": { "operator": "gt", "threshold": 85, "durationMinutes": 5, "severity": "warning" } }
] }
```

`key` is one of: `offline` (server stops reporting; `threshold` = minutes without data), `cpu`, `memory`, `disk` (percent, server), `website_down`, `website_slow` (threshold in seconds), `ssl_days`, `domain_days` (days left, operator `lt`), `container_stopped`, `service_stopped`.
`kind` is `server` or `website` and decides what `scope` applies to. `available: false` means no data exists yet (containers/services); a rule can still be created and starts working once data arrives.

## Templates

`GET /api/alerts/templates`

```json
{ "items": [
  { "key": "disk_almost_full", "name": "Disk almost full", "description": "Disk space is over 85% for 5 minutes.",
    "kind": "server", "available": true, "alreadyCreated": false,
    "rule": { "metric": "disk", "operator": "gt", "threshold": 85, "durationMinutes": 5, "severity": "warning" },
    "summary": "Alert me when disk space used is above 85% for 5 minutes on all servers." }
] }
```

Template keys: `server_down`, `disk_almost_full`, `cpu_very_high`, `memory_almost_full`, `website_down`, `website_slow`, `ssl_expires_soon`, `domain_expires_soon`, `container_stopped`, `service_stopped`.

`POST /api/alerts/rules/from-template` body `{ "templateKey": "cpu_very_high", "name"?: "...", ...any rule field to override }` -> 201 rule.

## Rules

Rule JSON:

```json
{
  "id": "uuid", "name": "Disk almost full", "templateKey": "disk_almost_full", "enabled": true,
  "metric": "disk", "kind": "server", "operator": "gt", "threshold": 85,
  "durationMinutes": 5, "severity": "warning", "cooldownMinutes": 30,
  "scope": { "type": "all", "ids": [] },
  "contactIds": [], "contacts": "all",
  "silenceUntil": null,
  "summary": "Alert me when disk space used is above 85% for 5 minutes on all servers.",
  "sendTo": "all your contacts",
  "openIncidents": 0, "createdAt": "..."
}
```

- `scope.type`: `all` or `selected`. For `selected`, `scope.ids` are server ids (the agent `id` from `/api/servers`) when `kind` is `server`, or website ids (`/api/websites`) when `kind` is `website`.
- `contactIds`: empty = send to all enabled contacts (`contacts: "all"`); otherwise only those contacts (`contacts: "selected"`). Ids come from `/api/contacts`.
- `durationMinutes`: 0-60. "For 5 minutes" means every stored sample in the last 5 minutes breaches; a shorter spike does not fire. `0` = latest sample.
- `cooldownMinutes` 1-1440 (default 30): no second alert for the same rule and resource within this time of the last one.
- `severity`: `warning` | `critical`.

| Method and path | Body | Result |
| --- | --- | --- |
| `GET /api/alerts/rules` | | `{ items: Rule[], limit: { used, max } }` |
| `POST /api/alerts/rules` | `{ name, metric, operator?, threshold?, durationMinutes?, severity?, cooldownMinutes?, scope?, contactIds?, enabled? }` (anything omitted takes the metric default) | 201 Rule; 402 over plan limit |
| `PATCH /api/alerts/rules/:id` | any subset of the fields above plus `silenceUntil` (ISO or null) | Rule |
| `DELETE /api/alerts/rules/:id` | | 204 (history is kept; open incidents close quietly) |

New organizations start with three enabled rules: `server_down`, `disk_almost_full`, `website_down`.

## Incidents (history)

`GET /api/alerts/incidents?state=open|resolved|firing|acknowledged&ruleId=&resourceId=&from=&to=&limit=50&before=<ISO startedAt>`

```json
{ "items": [
  { "id": "uuid", "ruleId": "uuid", "ruleName": "Disk almost full", "name": "Disk almost full on web-1",
    "metric": "disk", "severity": "warning", "state": "firing", "value": 91.2, "valueText": "91.2%",
    "resource": { "id": "uuid", "name": "web-1", "kind": "server" },
    "startedAt": "...", "acknowledgedAt": null, "resolvedAt": null, "lastNotifiedAt": "...", "notified": true },
  ],
  "nextBefore": null }
```

`state`: `firing` | `acknowledged` | `resolved`. `open` filter = firing + acknowledged. `nextBefore` is non-null when more rows exist (pass it as `before`).

- `PATCH /api/alerts/incidents/:id` body `{ "state": "acknowledged" | "resolved" }` -> incident.
- `GET /api/alerts/summary` -> `{ firing: 1, acknowledged: 0, recent: Incident[5] }`.
- `POST /api/alerts/evaluate` -> run an evaluation now (rate limited), `{ message }`.

Recovery notifications are sent when an incident that notified closes; recovery needs the condition clear for about a minute (flap protection).
The old `/api/alerts`, `/api/alerts/rules` (project-scoped shape), `/api/notifications*` and `/api/uptime*` routes are gone. Use this API, `/api/contacts` and `/api/websites`.
