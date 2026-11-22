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

Services are things running **on a host** with the agent. Websites, APIs and public TCP ports are uptime monitors and are
added under Websites & APIs (`POST /api/websites`), never here.

Owner or admin only (403 otherwise). Everything is scoped to the caller's organization.

Body (strict, Zod):

```json
{ "type": "tcp|nginx|apache|mysql|postgres|mssql|redis|systemd|process",
  "name": "string 1..100",
  "host": "agent id (required)",
  "port": 1, "url": "http(s) url (nginx, apache)", "address": "hostname or IP the agent dials (tcp and databases, optional)",
  "unit": "systemd unit", "processName": "process name",
  "credentialsRef": "optional, databases only: ^[a-z0-9][a-z0-9-]{0,39}$" }
```

Every type needs `host`. Without it: 400. For `tcp` the message is
`"Choose the host. For a public address use Websites & APIs."`. `website` and `api` are not valid types (400).

| type | agent entry written to the host's config |
|---|---|
| `tcp` | `{kind:"port", name, port, host: address?}`, `port` required |
| `nginx`, `apache` | `{kind, name, url}`; `url` optional (default `http://127.0.0.1/nginx_status`, `http://127.0.0.1/server-status?auto`) |
| `mysql`, `postgres`, `mssql`, `redis` | `{kind, name, port, host: address?, credentialsRef?}`; `port` defaults to 3306, 5432, 1433, 6379 |
| `systemd` | `{kind:"systemd", name}`, name = `unit` (falls back to `name`) |
| `process` | `{kind:"process", name}`, name = `processName` (falls back to `name`) |

`credentialsRef` (databases only, else 400) names a secret the agent reads on the host, from the environment
(`YUKTIOPS_CRED_<REF>_USER` / `_PASSWORD`, or `_URL`) or `<configDir>/credentials.d/<ref>.env` (mode 0600). YuktiOps never
receives or stores the password. See docs/api/advanced-telemetry.md section 6. The agent reports the result in the
service's `detail` (`authenticated`, `auth failed: wrong user or password`, `credentials not found`, ...).

Agent entries are appended to the host's AgentConfig `collectors.services[]` (same bump/copy rules as
`PATCH /api/servers/:id`), so the agent picks it up on its next config pull.

Response `201`:

```json
{ "id": "cfg....", "status": "pending", "source": "agent", "type": "mssql", "kind": "port|nginx|mssql|...",
  "name": "...", "serverId": "agent id", "monitorId": null }
```

`id` is `cfg.<agentId>.<kind>.<base64url(name)>` until the agent reports the service, after which the service has its
normal uuid in `GET /api/services`. `source` is always `agent` and `monitorId` always `null` (kept for compatibility).

`GET /api/services/:id` also returns what the host's config holds for the service, when present: `address`, `url` and
`credentialsRef` (never a secret).

Errors: 400 validation (missing host/port, bad url, bad `credentialsRef`), 403 role, 404 host not found,
409 service with the same kind and name already configured on that host.

`DELETE /api/services/:id` (204): accepts a reported service uuid (removes its entry from the host's
`collectors.services[]` and the reported row) or a `cfg.` id (removes the config entry). Unknown or other-org ids, and
monitor ids: 404 (use `DELETE /api/websites/:id`). Idempotent for reported rows: a row whose host is gone is still removed.

### `PATCH /api/services/:id` (admin)

Body: any subset of `{ name, url, host, port, address, unit, processName, credentialsRef }`
(strict, at least one field; `type` cannot change). Fields that do not apply to the service are 400
(`"<field> cannot be changed on a <kind> service."`).

- Accepts a reported uuid or a `cfg.` id: `name`, plus `unit` (systemd), `processName` (process), `port`/`address`
  (port, mysql, postgres, mssql, redis; address is stored as the entry's `host`), `url` (nginx, apache), `credentialsRef`
  (mysql, postgres, mssql, redis; `null` or `""` removes it). `host` may only repeat the current host. Same bump/copy
  rules as POST.

Response 200, same shape as POST: `{ id, status, source, type, kind, name, serverId, monitorId }`. The returned `id` is
the `cfg.` id of the edited entry and **changes when the name changes**. Errors: 400, 403, 404, 409
(duplicate kind+name on the host). Audit: `service.updated`.

## C.4 Rupee-first billing

- `GET /api/billing` now returns `defaultCurrency: "INR"` (plus the existing fields).
- `POST /api/billing/checkout`: `currency` defaults to `INR` (Razorpay, 18% GST added at invoicing: CGST+SGST or IGST
  lines in `taxBreakdown`). `USD` uses Stripe only when sent explicitly. After a provider subscription exists, the
  currency is locked (409 when switching provider), unchanged.
- Dev `POST /api/billing/change` (BILLING_DEV_MODE) accepts optional `currency` (default `INR`). The simulated invoice is
  INR with `subtotal`, `tax` (18%), `taxRate: 0.18`, `taxBreakdown` and `amount = total`; `USD` keeps the old
  untaxed USD invoice.
