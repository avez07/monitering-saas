# YuktiOps — Resolution Report

Orchestrated by three sub-agents (Backend, Frontend, DevOps) plus orchestrator QA. Nothing was committed.

## Verification summary
| Check | Result |
|---|---|
| `npm test -w backend` | 184 pass, 0 fail, 15 skipped (ClickHouse OTel tests; ClickHouse not running). Run with a temporary Redis container. |
| `npm test -w frontend` | 23 pass (6 new cURL parser tests) |
| `npm run build -w frontend` | OK |
| `docker build -t yuktiops-agent:local -f agent/Dockerfile agent` | OK |
| `docker compose config` (with/without `--profile agent`) | OK |
| Not run | UI in a browser, compose agent against a live API, dev-terminal scripts, collector example, ClickHouse tests |

## Bugs

### BUG-01 Docker agent image pull denied — fixed (workaround + docs)
- **Root cause:** `ghcr.io/yuktiops/agent` is only pushed by the GoReleaser release workflow; GHCR packages are private by default (anonymous pulls return "denied") and the image may never have been published. The repo had no way to build the image locally.
- **Fix:** new `agent/Dockerfile` (Go multi-stage → distroless); `agent` compose profile; image name overridable (`VITE_YUKTIOPS_AGENT_IMAGE`, `YUKTIOPS_AGENT_IMAGE`); the Docker panel in the Add server UI now shows a "denied → build locally" box; docs updated (agent/README, START, site install pages, install.sh hint, workflow comment).
- **Commands:** `docker build -t yuktiops-agent:local -f agent/Dockerfile agent`, then run the original command with `yuktiops-agent:local`; or `docker compose --profile agent up -d --build`.
- **Owner action needed:** publish a release and set the GHCR package to Public (Package settings → Change visibility), or `docker login ghcr.io`.

### BUG-02 Service deletion fails — hardened; cause not confirmed
- Could not reproduce on a healthy stack. Most likely trigger: Redis down made cache invalidation in `store.js` throw 500.
- **Fix:** cache invalidation best-effort; stale reported rows (host gone) can now be deleted; idempotent `deleteMany` (no P2025 on concurrent delete); monitor deletion also unschedules its queue job; descriptive error instead of the generic message. FK cascade monitor→checks verified by test.

### BUG-03 "The API is unavailable" on edit — fixed (certain)
- **Root cause:** no `PATCH /services/:id` route existed → Express HTML 404 → frontend's non-JSON fallback message.
- **Fix:** `PATCH /api/services/:id` (admin, audited) for monitors and agent-config entries, returns the same shape as POST; frontend `EditServiceDialog` + "Edit" button on service detail. Agent-entry ids change when the name changes (UI navigates to the returned id).

### BUG-04 Servers page fails to load — hardened; cause not confirmed
- Not reproducible on a healthy stack. `GET /servers` now tolerates odd `includeDockerHosts` values, non-object labels, null names, missing `lastSeen`; a malformed row is skipped and logged instead of failing the page. Redis/Prisma-out-of-date errors now return a descriptive 503.

### BUG-05 UI stuck on "Saving..." — fixed
- **Root cause:** `api()` had no timeout, so a hung request left the mutation pending forever (forms already used react-query `isPending`, which resets on error).
- **Fix:** 30s AbortController timeout; clearer messages for timeout, network failure, 404, 502–504, 429, other 5xx.

### BUG-06 OTel key creation error — hardened; cause not confirmed
- Key creation itself worked in tests. The banner matches the Connect page's `/apps/connection` poll, which read Redis and returned 500 on failure; `readSeen` also made `POST /telemetry-keys` 500 *after* storing the key.
- **Fix:** `readSeen` degrades to nulls; inline error alert with real message + retry on the Connect page. Response shape unchanged.

## Features
- **FEAT-01** Separate terminals: `npm run dev:backend`, `dev:worker`, `dev:frontend`, `dev:all`, and `npm run dev:terminals` (opens each in its own Windows Terminal tab / window, or tmux/Terminal/gnome-terminal). Combined `dev` unchanged. Documented in START.md/README.
- **FEAT-02** "Test it locally" collapsible guides for website, api, tcp, nginx, apache, mysql, postgres, redis, systemd, process, frontend, backend, worker, server — shown in Add service, service detail, website dialog, and OTel Connect page. (Not added to the Add server wizard.)
- **FEAT-03** "Paste cURL" in the website/API monitor dialog (`frontend/src/lib/curl.js`): method, URL, headers, body, basic auth, `-G`, line continuations. **Gap:** backend has no separate query-param field, so params stay in the URL; bodies over 4096 chars are truncated.
- **FEAT-04** Overview charts: uptime, response time, CPU/memory, alerts/day, from existing endpoints (one request per site/server, capped at 8 each, refresh 60s).

## Honest caveats
- BUG-02, 04, 06 were **not reproduced**; fixes are hardening against the most likely cause (Redis unavailable). Please ensure Redis and Postgres are running (`docker compose up`) and re-test; check backend logs, which now include stack traces for 5xx.
- The edit-service form pre-fills only fields that `GET /services/:id` returns; others start empty and only filled fields are sent.
- Site Docker pages still show the `ghcr.io` image in the main command (troubleshooting text added only).
- `backend/downloads/install.sh` is gitignored; the edited copy was synced locally.
- `createMonitor` doesn't schedule immediately on POST (housekeeping sync picks it up) — unchanged.

## Files
**Backend:** `src/data/store.js`, `src/lib/errors.js`, `src/routes/{services,servers}.js`, `src/services/{service-setup,servers,otel-auth}.js`, `test/service-edit.test.js` (new), `docs/api/{phase16,apps}.md`
**Frontend:** `lib/api.js`, `lib/curl.js`*, `pages/websites/WebsiteDialog.jsx`, `pages/services/{ServiceDetail,AddServiceDialog,EditServiceDialog*,LocalTestGuide*,local-test-guides*}`, `pages/apps/Connect.jsx`, `pages/overview/{index,OverviewCharts*,chart-data*}`, `pages/add-server/{model,DockerPanel}.jsx`, `test/curl.test.js*`, `package.json`
**DevOps:** `agent/Dockerfile*`, `docker-compose.yml`, `package.json`, `scripts/dev-terminals.{ps1,sh,mjs}*`, `.github/workflows/agent-release.yml`, README/START/agent README, `agent/scripts/install.sh`, site docs (docker install pages, otel-collector)

(* = new)
