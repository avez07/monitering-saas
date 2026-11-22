# Phase 16 API: Docker hosts, Add a service, INR-first billing (PLAN_2 C.2 to C.4)

All routes are cookie-authenticated under `/api`. Errors are `{ "error": "..." }`.

## C.2 Host kind (`server` | `docker-host`)

- New `Agent.kind` column (default `server`). It is set when the agent registers, from its setup profile
  (`settings.hostKind`, default `server`), and kept in sync when the profile is changed through
  `PATCH /api/servers/:id` (`config.hostKind`). `hostKind` is a new optional key of the agent settings
  (`"server" | "docker-host"`), so `/api/agent-configs` accepts it too.
- `GET /api/servers`: docker hosts are excluded by default. `?includeDockerHosts=true` includes them.
  Every server summary (list and detail) now has `"kind": "server" | "docker-host"`.
  `GET /api/servers/:id` always works for docker hosts.
- `GET /api/containers` (and detail): containers from ALL hosts are returned. Each item has
  `serverKind` (`server` | `docker-host`).
- Plan limits: a docker host is a normal host row, so it counts toward the plan's server limit exactly like a server.
- Turning containers on for an existing server: `PATCH /api/servers/:id` with
  `{ "config": { ...settings, "collectors": { ..., "docker": true } } }` (owner/admin; unchanged endpoint).
  The config version is bumped (or a private copy of a shared profile is created) so the agent re-pulls.

## C.3 `POST /api/services` and `DELETE /api/services/:id`

Owner or admin only (403 otherwise). Everything is scoped to the caller's organization.

Body (strict, Zod):

```json
{ "type": "website|api|tcp|nginx|apache|mysql|postgres|redis|systemd|process",
  "name": "string 1..100",
  "host": "agent id (optional)",
  "port": 1, "url": "http(s) url", "address": "hostname or IP (public tcp only)",
  "unit": "systemd unit", "processName": "process name" }
```

Routing:

| type | no `host` | with `host` |
|---|---|---|
| `website` | Websites & APIs monitor (type `http`), needs `url` | same (monitor; `host` ignored) |
| `api` | monitor (type `api`), needs `url` | same |
| `tcp` | public TCP monitor, needs `address` and `port` | agent entry `{kind:"port", name, port, host: address?}` |
| `nginx`, `apache` | 400 (host required) | agent entry; `url` optional (default `http://127.0.0.1/nginx_status`, `http://127.0.0.1/server-status?auto`) |
| `mysql`, `postgres`, `redis` | 400 | agent entry, `port` optional |
| `systemd` | 400 | agent entry, name = `unit` (falls back to `name`) |
| `process` | 400 | agent entry, name = `processName` (falls back to `name`) |

Agent entries are appended to the host's AgentConfig `collectors.services[]` (same bump/copy rules as
`PATCH /api/servers/:id`), so the agent picks it up on its next config pull.

Response `201`:

```json
{ "id": "...", "status": "pending", "source": "monitor|agent", "type": "website", "kind": "http|api|tcp|nginx|...",
  "name": "...", "serverId": "agent id | null", "monitorId": "uuid | null" }
```

`id` for `source:"monitor"` is the monitor id. For `source:"agent"` it is `cfg.<agentId>.<kind>.<base64url(name)>`
until the agent reports the service, after which the service has its normal uuid in `GET /api/services`.

Errors: 400 validation (missing url/host/port, bad url), 402 plan monitor limit, 403 role, 404 host not found,
409 service with the same kind and name already configured on that host.

`DELETE /api/services/:id` (204): accepts a reported service uuid (removes its entry from the host's
`collectors.services[]` and the reported row), a `cfg.` id (removes the config entry), or a monitor id (removes the
monitor, same as `DELETE /api/websites/:id`). Unknown or other-org ids: 404. Idempotent for reported rows: a row whose host
is gone is still removed.

### `PATCH /api/services/:id` (admin)

Body: any subset of `{ name, url, host, port, address, unit, processName, intervalSeconds, failureThreshold }`
(strict, at least one field; `type` cannot change). Fields that do not apply to the service are 400
(`"<field> cannot be changed on a <kind> service."`).

- Monitor ids (website/api/tcp): `name`, `url` (http/https) or `address`+`port` (tcp), `intervalSeconds` (>= plan minimum, else
  402), `failureThreshold` (1-10). The target is re-resolved (blocked/private addresses are 400).
- Agent entries (reported uuid or `cfg.` id): `name`, plus `unit` (systemd), `processName` (process), `port`/`address`
  (port, mysql, postgres, redis; address is stored as the entry's `host`), `url` (nginx, apache). `host` may only repeat the
  current host. Same bump/copy rules as POST.

Response 200, same shape as POST: `{ id, status, source, type, kind, name, serverId, monitorId }`. For `source:"agent"` the
returned `id` is the `cfg.` id of the edited entry and **changes when the name changes**. Errors: 400, 402, 403, 404, 409
(duplicate kind+name on the host). Audit: `service.updated`.

## C.4 Rupee-first billing

- `GET /api/billing` now returns `defaultCurrency: "INR"` (plus the existing fields).
- `POST /api/billing/checkout`: `currency` defaults to `INR` (Razorpay, 18% GST added at invoicing: CGST+SGST or IGST
  lines in `taxBreakdown`). `USD` uses Stripe only when sent explicitly. After a provider subscription exists, the
  currency is locked (409 when switching provider), unchanged.
- Dev `POST /api/billing/change` (BILLING_DEV_MODE) accepts optional `currency` (default `INR`). The simulated invoice is
  INR with `subtotal`, `tax` (18%), `taxRate: 0.18`, `taxBreakdown` and `amount = total`; `USD` keeps the old
  untaxed USD invoice.
