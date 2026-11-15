# Websites API

Cookie-authenticated, CSRF-guarded. Errors `{ "error": "..." }`. Any member can read; `owner`/`admin` can write. Websites need no agent: this works for shared-hosting users.

Website JSON:

```json
{
  "id": "uuid", "name": "Marketing site", "type": "http",
  "target": "https://example.com", "host": "example.com", "port": null,
  "method": "GET", "headers": {}, "hasBody": false, "expectedStatus": null,
  "keyword": null, "keywordMode": "present", "jsonContains": null,
  "intervalSeconds": 300, "timeoutSeconds": 10, "failuresBeforeDown": 2,
  "enabled": true, "paused": false,
  "status": "up", "retrying": false, "downSince": null,
  "latencyMs": 123, "lastCheckedAt": "...", "nextCheckAt": "...", "lastError": null,
  "uptime24h": 99.95,
  "ssl": { "expiresAt": "...", "daysLeft": 80, "warning": null },
  "domain": { "name": "example.com", "expiresAt": "...", "daysLeft": 200, "warning": null, "status": "ok" },
  "createdAt": "..."
}
```

- `type`: `http` (page loads, 2xx/3xx), `keyword`, `api`, `tcp`.
- `status`: `pending` (never checked) | `up` | `down` | `paused`. `retrying: true` means the last check failed but not enough times to call it down yet.
- `headers` values are masked (`"••••"`); send `"••••"` back to keep an existing value.
- `ssl`/`domain` are null when unknown (not https, no RDAP for that TLD, not checked yet). `warning` is `30`, `14`, `7` (days-left bands) or `0` (expired). `domain.status`: `ok` | `unsupported` | `error`.
- `uptime24h` is a percent or null when there are no checks.

## Endpoints

| Method and path | Body | Result |
| --- | --- | --- |
| `GET /api/websites` | | `{ items: Website[], limits: { used, max, minIntervalSeconds } }` |
| `POST /api/websites` | see below | 201 Website; 402 over plan count / interval; 400 private address |
| `GET /api/websites/:id` | | Website plus `uptime: { "24h": 99.9, "7d": .., "30d": .. }` |
| `PATCH /api/websites/:id` | any subset of the create fields (except `type`) | Website |
| `DELETE /api/websites/:id` | | 204 |
| `POST /api/websites/:id/pause` | | Website (`status: "paused"`); incidents close quietly |
| `POST /api/websites/:id/resume` | | Website (checked on the next worker pass) |
| `POST /api/websites/:id/check` | | `{ ok, statusCode, latencyMs, error }` runs one check now (10 per minute per org) |
| `GET /api/websites/:id/checks?range=1h\|24h\|7d\|30d` | | see below |

### Create body

```json
{ "name": "Shop", "type": "keyword", "url": "https://shop.example.com/", "intervalSeconds": 300,
  "timeoutSeconds": 10, "failuresBeforeDown": 2,
  "keyword": "Add to cart", "keywordMode": "present" }
```

| type | fields |
| --- | --- |
| `http` | `url` |
| `keyword` | `url`, `keyword` (1-200 chars), `keywordMode` `present` (default; down when missing) or `absent` (down when found) |
| `api` | `url`, `method` (`GET` default, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`), `headers` (object, max 10), `body` (string, max 4 KB), `expectedStatus` (100-599; default any 2xx), `jsonContains` (substring the response body must contain) |
| `tcp` | `host`, `port` (1-65535) |

`intervalSeconds` 30-86400, not below the plan minimum (Free 300, Starter/Pro 60, Business 30). `failuresBeforeDown` 1-5 (default 2): consecutive failed checks before the site is down (retries run every 30 s). Only public addresses are allowed (SSRF guard, re-checked on every request).

### Check history

`GET /api/websites/:id/checks?range=24h` (range is clamped to the plan's retention)

```json
{ "range": "24h", "bucketSeconds": 300, "uptimePercent": 99.9, "avgLatencyMs": 140, "checks": 288,
  "points": [ { "time": "...", "avgLatencyMs": 120, "maxLatencyMs": 300, "ok": 5, "failed": 0 } ],
  "recent": [ { "time": "...", "ok": false, "statusCode": 503, "latencyMs": 80, "error": "status_503" } ] }
```

`recent` = the last 20 raw checks. `error` is a short code (`timeout`, `dns`, `connection_refused`, `tls`, `status_<code>`, `keyword_missing`, `keyword_found`, `json_missing`, `blocked_address`).

Alerting for websites uses `/api/alerts` metrics `website_down`, `website_slow`, `ssl_days`, `domain_days`. New orgs get a default "Website is down" rule.
