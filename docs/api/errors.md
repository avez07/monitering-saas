# API errors

Every error answer from the API is JSON with the same shape. `error` is the old plain-message field and is kept for older callers; it always equals `message`.

```json
{
  "error": "The database is not reachable.",
  "code": "database_unreachable",
  "message": "The database is not reachable.",
  "service": "database",
  "cause": "Can't reach database server at `db:5432`",
  "timestamp": "2026-01-01T12:00:00.000Z",
  "hint": "Check that PostgreSQL is running and DATABASE_URL points to it (docker compose up -d db).",
  "errorId": "9f3c2a1b"
}
```

- `cause` (5xx only) is a short redacted technical reason. The full error and stack trace go to the **server log** with the same `errorId`, never to the browser.
- API keys (`yk_live_...`), bearer tokens, `user:password@` in URLs and `password=` / `token=` values are redacted from both the response and the log.
- Only `internal_error` is HTTP 500, and it means a bug on our side: quote the `errorId`.
- 503 answers carry `Retry-After: 5`.

## Codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `validation_failed` | 400 | The request body or query is invalid; `message` lists the fields. |
| `bad_request`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `payload_too_large`, `rate_limited`, ... | 4xx | The usual meaning of the status. Routes may set a more specific `code` (for example `invalid_api_key`). |
| `database_unreachable` | 503 | PostgreSQL cannot be reached (down, wrong `DATABASE_URL`, network). |
| `database_timeout` | 504 | No database connection became free in time (pool exhausted, slow queries). |
| `database_out_of_date` | 503 | Migrations have not been applied: `npm run db:migrate`. |
| `database_auth_failed` | 503 | The database refused the configured user or password. |
| `redis_unreachable` | 503 | Redis cannot be reached (limits, queues and caches need it). |
| `upstream_refused` | 502 | Another service the API called refused the connection (nothing listens there). |
| `upstream_timeout` | 504 | Another service did not answer in time. |
| `upstream_dns_failed` | 502 | A host name could not be resolved. |
| `upstream_reset` / `upstream_unreachable` | 502 | The connection was reset, or there is no route to the host. |
| `upstream_tls_failed` | 502 | Certificate or TLS handshake problem with another service. |
| `internal_error` | 500 | An unexpected bug. Logged with its stack trace under the `errorId`. |

## Service health

`GET /api/services` and `GET /api/services/:id` include `health`: `null` when the service is running, otherwise

```json
{ "code": "connection_refused", "message": "The service refused the connection.", "service": "redis",
  "cause": "connection refused", "since": "2026-01-01T11:58:00.000Z", "hint": "...", "severity": "critical",
  "timestamp": "2026-01-01T12:00:00.000Z" }
```

| Code | Meaning |
| --- | --- |
| `agent_offline` | The agent on that server has not reported for more than 2.5 minutes, so the service state is out of date. Checked first. |
| `service_failed` | systemd (or the probe) reports the unit as failed. |
| `service_stopped` | The service is stopped or inactive. |
| `process_not_found` | The process or unit is not running. |
| `connection_refused` | The agent could reach the host but nothing listens on the port. |
| `connection_timeout` | The port did not answer in time (firewall, hang, overload). |
| `dns_failed` | The agent could not resolve the service's host name. |
| `unhealthy_response` | The port answered but the reply was not valid for that kind (redis, mysql, postgres, nginx, apache). |
| `unknown_state` | The agent could not tell; run `yuktiops-agent doctor`. |

Not collected today: container exit codes, container healthcheck results and log lines. The agent does not read them, so the API cannot show them. See "Follow-ups" in the pull request.

An agent that sends a wrong credential gets `401` (`credential_revoked` in the agent's own codes, see `connection.md`).
