# Local Test Guide — YuktiOps bug fixes & features

Covers BUG-01…06 and FEAT-01…04 from `yuktiops_tasks.md` (see `resolve.md` for what changed). Run commands from the repo root. Examples are PowerShell. Check the boxes as you go.

## 0. Prerequisites & setup

- Node 22.12+, npm, Docker Desktop running.
- **Redis must be running.** Redis being down is the most likely cause of BUG-02/04/06 and was the main thing the backend fixes hardened against.

```powershell
Copy-Item .env.example .env          # only if you have no .env
docker compose up -d postgres redis mailpit clickhouse
docker compose ps                    # all four "running"/"healthy"
npm install
npm run db:generate
npm run db:migrate
```

ClickHouse is needed only for the OpenTelemetry pages/tests (section 8). If you skip it, Apps pages show "Telemetry storage is unavailable", which is expected.

## 1. Automated checks (do these first)

```powershell
npm test -w backend      # expect: 0 fail (15 skipped if ClickHouse is not running; 0 skipped if it is)
npm test -w frontend     # expect: 23 pass
npm run build -w frontend
```

- [ ] Backend tests: 0 failures. The new file is `backend/test/service-edit.test.js` (7 tests).
- [ ] Frontend tests: 23 pass, including `test/curl.test.js`.
- [ ] Build finishes without errors.

## 2. FEAT-01 — Separate terminals (Frontend / Backend / Worker)

Option A, one terminal each (open 3 terminals):

```powershell
npm run dev:backend      # terminal 1 → API on :4000
npm run dev:worker       # terminal 2 → background worker
npm run dev:frontend     # terminal 3 → dashboard on :5173
```

Option B, open all three automatically: `npm run dev:terminals`.

- [ ] Each command starts only its own service and logs only its own output.
- [ ] http://localhost:4000/api/health returns OK; http://localhost:5173 loads the dashboard.
- [ ] Old `npm run dev` (combined) and `npm run dev:all` still work.

Keep these running for the sections below. Sign up at http://localhost:5173/register (verify the email in Mailpit, http://localhost:8025, if prompted).

## 3. BUG-01 — Docker agent image ("denied")

Get an API key from **Add your first server → Create API key** (or Settings → API key).

```powershell
# 1. Reproduce the original problem (expected: denied, unless the image is now public)
docker pull ghcr.io/yuktiops/agent:latest

# 2. Build the agent image locally
docker build -t yuktiops-agent:local -f agent/Dockerfile agent
```

- [ ] The local build succeeds.
- [ ] In the dashboard: **Add server → Docker**. Below the command there is a box **“See "denied" or "pull access denied"?”** with the build command and `docker login ghcr.io` hint.
- [ ] Run the agent with the local image (replace the key):

```powershell
docker run -d --name yuktiops-agent --restart unless-stopped `
  --pid host --network host `
  -v /:/host:ro -e HOST_ROOT=/host `
  -e YUKTIOPS_API_KEY=yk_live_a564eb5d5858008c7022a90ffa7aed2d839a4dfbd5c89784c5c219c6ec7fff37`
  -e YUKTIOPS_API_URL=http://host.docker.internal:4000 -e YUKTIOPS_ALLOW_INSECURE=true`
  -v yuktiops-agent:/var/lib/yuktiops `
  -v /var/run/docker.sock:/var/run/docker.sock:ro --group-add 0 `
  yuktiops-agent:local
docker logs yuktiops-agent
```

- [ ] Container stays up; the wizard shows **Connected!** and the server appears under Servers within ~1 minute.
  - Note: on Docker Desktop (Windows/Mac) `--network host` and `/:/host` behave differently (they refer to the Docker VM). If it can't reach the API, use `-e YUKTIOPS_API_URL=http://host.docker.internal:4000` and drop `--network host`. This is not verified by the agents, so report back if it needs a tweak.
- [ ] Compose alternative: `$env:YUKTIOPS_API_KEY="yk_live_..."; docker compose --profile agent up -d --build`.
- Cleanup: `docker rm -f yuktiops-agent`.
- Fallback without Docker: `node backend/scripts/agent.mjs --register --key yk_live_<key> --api http://localhost:4000`.

## 4. BUG-04 — Servers page loads

(Needs at least one connected server from section 3, or an empty state.)

- [ ] Open **Servers**: list (or the empty state) loads, no "We couldn't load your servers".
- [ ] Open a server: charts and the Connection tab load.
- [ ] Negative test: stop Redis (`docker compose stop redis`), reload Servers. Expected: either the list still loads, or a **descriptive** error with a "Try again" button (not a blank/generic failure). Restart: `docker compose start redis`, click Try again, list loads.
- [ ] API check (needs your session cookie; easiest is the browser address bar while logged in): `http://localhost:5173/api/servers?includeDockerHosts=maybe` returns 200 JSON (previously 400).

## 5. BUG-02 / BUG-03 — Delete and edit a service

Create services: **Services → Add a service**.

1. Add a **Website** (use a public URL, e.g. `https://example.com`; loopback is blocked unless the API was started with `E2E_ALLOW_LOOPBACK=1`).
2. Add a **TCP** check (e.g. `example.com` port `443`).
3. If a server is connected: add a **systemd** or **process** service on that host.

**Edit (BUG-03):**
- [ ] Open a service → **Edit**. Change the name (and URL/port for monitors) → Save. The dialog closes, the new values show, no "The API is unavailable".
- [ ] For the agent-reported entry: rename it; the page redirects to the new id and works (the old URL no longer exists, expected).
- [ ] Try a duplicate name on the same host: a clear "already being monitored" (409) message.
- [ ] Try a URL that isn't http/https or a private address: a clear validation error, dialog not stuck.
- [ ] Optional API check from browser devtools console while logged in (CSRF-style same-origin):
  `fetch('/api/services/<id>',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'renamed'})}).then(r=>r.json()).then(console.log)`
  Expected: `{id,status,source,type,kind,name,serverId,monitorId}`.

**Delete (BUG-02):**
- [ ] Delete the website monitor (after it has run a check or two): row disappears, no "The service could not complete this request."
- [ ] Delete the TCP monitor and the agent-config service.
- [ ] Reload: deleted items stay gone; deleting again (stale tab) gives "Service not found", not a crash.
- [ ] Negative: stop Redis, delete a service. It should still succeed or show a descriptive message. Restart Redis afterward.
- [ ] Look at the **backend terminal**: any 5xx now logs a stack trace. Paste it if something fails.

## 6. BUG-05 — "Saving…" never freezes

- [ ] **Websites & APIs → Add**: fill the form, press Save → button returns to normal after success or error.
- [ ] Force a failure: stop the backend (Ctrl+C in terminal 1), press Save. Within ~30 seconds (or immediately if refused) you get an error such as "Could not reach the API…" or "The request took too long…", and the button resets. Restart the backend and save again: works.
- [ ] Force a validation error (e.g. invalid URL): error message shown, button re-enabled.
- [ ] Repeat on another form (rename a server in Settings, create an alert) to confirm none stays on "Saving…".

## 7. FEAT-03 — Paste cURL

**Websites & APIs → Add** (or edit) → **Paste cURL**. Paste each, confirm the fields:

```bash
curl -X POST 'https://api.example.com/v1/items?limit=5' -H 'Authorization: Bearer abc' -H 'Content-Type: application/json' -d '{"name":"test"}'
```
- [ ] Type switches to **API check**; method POST; URL includes `?limit=5`; two headers; body `{"name":"test"}`.

```bash
curl https://example.com/health
```
- [ ] GET, URL only.

```bash
curl -u user:pass --header "Accept: application/json" \
  https://api.example.com/status
```
- [ ] Multi-line (`\`) works; Basic `Authorization` header created.

```bash
curl --json '{"a":1}' https://api.example.com/x
```
- [ ] Method POST with body (implied by `--json`).

- [ ] Save the API monitor; it appears in the list with the right method/URL. Known limits: query params stay in the URL (no separate field); bodies over 4096 characters are truncated; `-F`/`@file` data shows a warning.
- [ ] Garbage text in the box: shows a friendly message, doesn't break the form.

## 8. BUG-06 — OpenTelemetry key creation

Needs `clickhouse` running and migrated: `npm run ch:migrate -w backend` (if the app tells you storage is unavailable).

- [ ] Open **Apps → Connect** (OpenTelemetry setup). Create a telemetry key. A key `yk_otel_…` is shown once, **no red error banner**.
- [ ] Keys list shows the new key; the "waiting for data" status polls without errors.
- [ ] Negative: `docker compose stop redis`, create another key → still succeeds (or a clear message with Try again). Start Redis again.
- [ ] Send test data using the collector steps in `site/src/content/docs/otel-collector.md` ("Try it locally"), then confirm the app appears under Apps. Run `npm test -w backend` with ClickHouse up to include the 15 OTel tests.

## 9. FEAT-02 — Local testing guides

- [ ] **Add a service**: pick each type (website, api, tcp, nginx, apache, mysql, postgres, redis, systemd, process). A collapsible **Test it locally** section shows copy-paste commands and what healthy looks like.
- [ ] Open an existing service detail: the guide for its type is shown.
- [ ] Website/API dialog: guide present.
- [ ] Apps → Connect: Frontend, Backend and Worker guides appear.
- [ ] Try two of the commands (e.g. `curl -I https://example.com`, `redis-cli ping` via `docker exec <redis> redis-cli ping`) to confirm they're sensible.

## 10. FEAT-04 — Overview graphs

Needs at least one website monitor with some checks (wait a couple of minutes; worker interval is 30s in dev) and ideally a connected server.

- [ ] **Overview** shows charts: uptime, response time, CPU/memory, alerts per day.
- [ ] Hover tooltips work; empty states read sensibly with no data (use a fresh org); stop the backend and reload: charts show an error with retry rather than a blank page.
- [ ] Check dark mode (theme toggle) and phone width (narrow the window): no overflow.
- [ ] Network tab: roughly one request per site/server (max 8 each), refreshing every ~60s.

## 11. Regression pass

- [ ] Sign up / sign in / sign out, invite a team member (Mailpit), Alerts → add from template + test email.
- [ ] `npm run test:e2e` (Playwright, uses its own API on :4060 and DB). Not run by the agents; run it to catch UI regressions.
- [ ] `docker compose config` and `docker compose --profile agent config` both parse.

## Reporting results

For anything failing, collect: the exact steps, the on-screen message, the **backend terminal output** (stack traces are now logged for 5xx), and the browser devtools Network response for the failing request. Items that were hardened but never reproduced (BUG-02, 04, 06) are the most important ones to re-test with Redis both up and down.

## Cleanup

```powershell
docker rm -f yuktiops-agent
docker compose down          # add -v to also wipe local data
```
