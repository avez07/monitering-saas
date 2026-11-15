# YuktiOps: updated plan (v2, after first build test)

## What happens after approval

1. **Replace `PLAN.md`** with this document. `requirement.txt` stays untouched.
2. **Commit Phase 0** (already in the working tree, uncommitted) as the baseline, after re-running its checks.
3. **Implement only the phase you approve** (recommended: Phase 1, see the end), run its "done when" checks, then stop and report with step-by-step test instructions.

## Context

YuktiOps (yuktiops.com) is a simple, affordable server-monitoring SaaS for startups and small/mid-size companies on a VPS or shared hosting. Customers use it as their **main** monitoring or as an **independent watchdog** next to Datadog, New Relic, Prometheus or Netdata.

After Phase 0, the first hands-on test showed the product is not sellable yet:

- **No way to get the agent.** There is no download, no build pipeline, and onboarding still prints `node backend/scripts/agent.mjs …`, which only works inside this repo.
- **Setup is "just a command".** No guidance, no choice of OS or what to monitor, no visible config.
- **Duplicate flows:** "Connect a server" (Overview, Servers) and "Connect agent" (Agents page) do the same thing, and `POST /api/resources` can still create a server by hand with no agent.
- **Per-server tokens:** every server needs a fresh 15-minute single-use token. That's secure, but tedious for 10+ servers.
- **No troubleshooting:** when data doesn't arrive, the user has no idea why.
- **Team access is broken:** Phase 0 correctly removed the unsafe "create member with password", but invites haven't been built yet, so nobody can be added. Roles are four (owner/admin/editor/viewer) plus per-project scoping, which is too complex for this audience.
- **The UI looks like a developer tool**, not a product non-technical buyers trust.

Design principles that still hold:

- **Coexistence:** the agent opens no ports, has no shared exporters, and stays under 25 MB RAM and 1% CPU.
- **Independence:** offline detection and website checks run on our side, so we alert even when the customer's own stack is down.
- **Integration (later):** signed webhooks, a read API, and a Prometheus-compatible export.

---

## 1. How customers get the agent (download, builds, install)

### 1.1 What the customer actually downloads

A single **static Go binary**, `yuktiops-agent`, with no dependencies: no Node, no Python, no libc version issues. The same binary does everything:

| Command                              | What it does                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `yuktiops-agent run`                 | The background process (started by systemd; users never type this)                                    |
| `yuktiops-agent register --key=…`    | Uses the account API key once to register this server, then saves the server's own credential         |
| `yuktiops-agent status`              | Plain-language status: "Running · Connected · last data sent 12 seconds ago"                          |
| `yuktiops-agent doctor`              | Tests DNS, HTTPS, proxy, clock, credential, permissions and service state, and prints fixes in plain English |
| `sudo yuktiops-agent uninstall`      | Stops and removes the service, binary, user and config (`--keep-config` to keep config)              |
| `yuktiops-agent version`             | Version and build info                                                                                |

### 1.2 How it is built for each OS and CPU

- **Source:** `agent/` in this repo (Go module).
- **Build tool:** **GoReleaser**, run by **GitHub Actions** when a tag like `agent/v0.4.1` is pushed.
  - Go cross-compiles from one Linux runner: `CGO_ENABLED=0 GOOS=linux GOARCH=amd64|arm64|arm(v7)`, with `-trimpath -ldflags "-s -w -X main.version=…"`. That's about 10 MB per binary.
  - **Launch targets:** Linux **x86-64 (amd64)**, Linux **ARM64** (AWS Graviton, Hetzner/Oracle ARM, Raspberry Pi 4/5) and Linux **ARMv7** (older Pis, cheap boards).
  - **Packages per target:** `.tar.gz`, `.deb` (Ubuntu/Debian), `.rpm` (RHEL/Rocky/Alma/CentOS/Amazon Linux, built with nfpm) and a multi-arch **Docker image** (`ghcr.io/yuktiops/agent`).
  - `checksums.txt` (SHA-256 of every file) plus a **cosign signature** of it.
- **Release pipeline:** test → build → upload files → smoke-test `install.sh` on a fresh Ubuntu runner (it has systemd) → **only then** update `latest.json`. A broken build therefore never becomes "latest".
- **Windows and macOS:** Go builds them easily, but the service install and some collectors differ. They're a later phase; the wizard shows them as "Coming soon".

### 1.3 Where it is hosted

- **Primary: Cloudflare R2** (S3-compatible object storage, **zero egress fees**, free up to 10 GB), behind our own domains:

  ```
  https://get.yuktiops.com                      → install.sh (latest)
  https://downloads.yuktiops.com/agent/
      latest.json                               → {"version":"0.4.1","files":{name: sha256, …}}
      v0.4.1/yuktiops-agent_0.4.1_linux_amd64.tar.gz
      v0.4.1/yuktiops-agent_0.4.1_linux_arm64.tar.gz
      v0.4.1/yuktiops-agent_0.4.1_amd64.deb   …_arm64.deb
      v0.4.1/yuktiops-agent-0.4.1.x86_64.rpm  …aarch64.rpm
      v0.4.1/install.sh                         → pinned copy for reproducible installs
      v0.4.1/checksums.txt  checksums.txt.sig
  ```

- **Mirror: GitHub Releases** of the agent. Recommendation: open-source the agent (Apache-2.0) in a public repo later. Customers trust code they can read when it runs on their servers, and Datadog, New Relic and Netdata all publish their agents. Until then the monorepo is fine.
- **Local development** (no R2 needed): `npm run agent:dist` builds into `backend/downloads/`, and the API serves it at `http://localhost:4000/downloads/`. `install.sh --base-url=…` points at it, so the whole flow works on a laptop or in WSL2.

### 1.4 What `install.sh` does, step by step

The user runs `curl -fsSL https://get.yuktiops.com | sudo bash -s -- --key=yk_live_… --setup=st_…`

1. The whole script is wrapped in a `main()` that is called on the last line, so a half-downloaded script never runs. It uses `set -euo pipefail`.
2. **Checks:** root (sudo), Linux, `systemd` present (if not, it prints the Docker alternative), and `curl` or `wget` plus `sha256sum`.
3. **Detects the CPU** with `uname -m` (`x86_64→amd64`, `aarch64→arm64`, `armv7l→armv7`) and reads the OS from `/etc/os-release` (it's reported to the dashboard; the tarball works on every distro).
4. **Downloads** `latest.json` (or `--version=`), the matching tarball and `checksums.txt` into a `mktemp` directory.
5. **Verifies SHA-256** and aborts with a clear message on mismatch. If `cosign` happens to be installed it also verifies the signature. (Signature checks become mandatory in the Go self-updater later, using an embedded public key.)
6. **Installs** `/usr/local/bin/yuktiops-agent` and creates the system user `yuktiops` (no login shell, no home). It creates `/etc/yuktiops` (0750 root:yuktiops) and `/var/lib/yuktiops` (owned by yuktiops, for the offline buffer and cached config).
7. **Registers:** `yuktiops-agent register --key … --setup …` exchanges the account key for **this server's own credential** and writes `/etc/yuktiops/agent.yaml` plus `credential` (0640). **The account API key is not stored on the server.**
8. **Starts the service:** it installs `yuktiops-agent.service`, then runs `systemctl enable --now` (starts now and on every reboot).
9. **Waits** up to 30 seconds for the first successful send. It then prints either "✓ Connected — open https://app.yuktiops.com/servers/…" or the `doctor` output with fixes.
10. **Re-running is safe:** it upgrades in place. `--uninstall` removes everything.

### 1.5 The Download button (no curl-pipe-bash)

The wizard calls `GET /api/agent/releases` (the API reads `latest.json`, cached for 5 minutes) and shows:

- **Download for Ubuntu/Debian (.deb)**, **RHEL/Rocky/Amazon (.rpm)** and **Other Linux (.tar.gz)**, each for x86-64 or ARM64, with the SHA-256 shown.
- **Download config file** (`agent.yaml`, generated from the wizard).
- Three copy-paste steps, for example `sudo dpkg -i yuktiops-agent_0.4.1_amd64.deb`, then `sudo yuktiops-agent register --key=…`, then `sudo systemctl enable --now yuktiops-agent`. The package's post-install script creates the user and unit; it does not start the service until registration.

A third tab, **Docker**, gives a `docker run -d --restart unless-stopped …` or compose snippet.

---

## 2. Product structure (dashboard sections)

Left navigation, in plain language. Each section says where its data comes from.

| Section                 | What it shows                                                                    | Data source                         |
| ----------------------- | -------------------------------------------------------------------------------- | ----------------------------------- |
| **Overview**            | Everything at a glance: what's down, what needs attention, recent alerts         | all                                 |
| **Servers**             | CPU, memory, disk, network, load, uptime, top processes; connection status       | agent                               |
| **Containers**          | Docker containers: running/stopped, restarts, CPU/memory per container           | agent (opt-in Docker collector)     |
| **Services**            | Things running _on_ your servers: nginx/Apache, MySQL/Postgres/Redis, systemd services, processes by name, local ports | agent |
| **Websites & APIs**     | Checked _from outside_: uptime, response time, keyword, SSL expiry, domain expiry, API endpoints | our check servers (no agent) |
| **Alerts**              | Alert rules (from templates), alert history, and "Where to send alerts"          | —                                   |
| **Settings**            | Team, API key, Plan & billing, Account                                           | —                                   |

The "Services" and "Websites & APIs" split rests on one rule: **inside your server** (needs the agent) versus **from the internet** (no install needed). That's what lets shared-hosting customers use Websites & APIs alone.

Projects stay in the data model, but **the project and environment pickers are hidden**. Every organization gets one default project; a "Groups" feature can come later. The "Agents" page disappears, because agents are servers.

---

## 3. Key design decisions for the new requests

### 3.1 One account API key (request 7)

- **New `ApiKey` model:** `id`, `orgId`, `name`, `prefix` (for example `yk_live_8f2k`), `tokenHash` (SHA-256), `createdById`, `lastUsedAt`, `revokedAt`, `createdAt`. One active key per organization.
- **Shown once** when it's created or regenerated. Only the hash is stored (reusing `token()` and `digest()` from `backend/src/lib/crypto.js`).
- **Purpose:** registers any number of servers. Registration still returns a **per-server credential**, which is what the agent actually uses, so:
  - **Regenerate** gives a new key; the old one stops working for _new_ installs, and **existing servers keep running**.
  - **Revoke** turns the key off, with an optional checkbox "Also disconnect all servers".
  - **Remove server** revokes that one server's credential (existing `revoke` logic in `backend/src/routes/agents.js`).
- **Re-installs don't create duplicates:** the agent sends a machine fingerprint (a SHA-256 of `/etc/machine-id`). Registering the same machine again reconnects it to the same server and rotates its credential.
- **Abuse limits:** registration is rate-limited per key and per IP, plan server limits are enforced (`enforceCount` in `backend/src/services/limits.js`), and an optional "New server connected" email goes out.
- **Wizard UX vs. show-once:** the key can't be re-displayed. In the wizard, if no key exists, a **Create API key** button creates it and fills it into the command. If one exists, the user pastes it ("starts with `yk_live_`"), with a **Lost it? Regenerate** link next to the field.
- **Removed:** 15-minute enrollment tokens (`AgentEnrollmentToken`, `POST /agents/enrollment-tokens`).

### 3.2 Generated config with simple edits (request 3)

- The wizard saves a **setup profile** (`AgentConfig`: id `st_…`, org, version, JSON settings). The install command references it with `--setup=st_…`, so the command stays short.
- The agent **pulls its config** on each send: the response carries a config version, and the agent fetches the new config when it changes. Editing a server's settings in the dashboard later works without SSH.
- **Security boundary:** remote config can only switch **built-in, read-only collectors** on or off and set names, intervals and thresholds. **The agent never executes commands sent from our servers.** This is stated in the docs.
- **Secrets stay on the customer's server.** Database monitoring passwords, when added later, go in `/etc/yuktiops/secrets.yaml` locally and are never stored in our database.

### 3.3 Connection status and troubleshooting (request 8)

A server has a **Connection** tab, and new servers show it automatically until they're healthy.

| Step shown to the user           | How we know                                                                                                     |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1. Install started               | `install.sh` posts install progress events (`downloaded`, `registered`, `service_started`)                      |
| 2. Agent installed & registered  | registration call received                                                                                      |
| 3. Agent running                 | data or heartbeat within the last 90 seconds                                                                     |
| 4. Data arriving                 | last data received, "12 seconds ago"                                                                            |
| 5. Problems reported             | the agent sends its recent errors with each payload (e.g. `docker_socket_denied`, `disk_permission`, `clock_skew`); the server records rejections (`401 revoked`, `429 plan limit`, `413 too large`) |

- **Storage:** a new `AgentEvent` table holds both kinds (agent-reported and server-detected), with the last 50 per server.
- **Error catalog** (`backend/src/services/agent-errors.js`): each code maps to a plain-language title, an explanation and the exact fix, for example:
  - "Your server can't reach YuktiOps over HTTPS (port 443). If you use a firewall, allow outbound HTTPS to api.yuktiops.com. Test it with: `curl -I https://api.yuktiops.com/health`."
  - "Your server's clock is 7 minutes off. Run `sudo timedatectl set-ntp true`."
  - "You've reached the 2-server limit of the Free plan. Upgrade or remove a server."
- **When nothing arrives** (for example, outbound HTTPS is blocked, so we can't hear the agent at all), the page says so honestly. It shows a checklist of likely causes plus "Run `sudo yuktiops-agent doctor` on the server", which tests everything locally and prints the same plain-language fixes.

### 3.4 Agent runs in the background (request 9)

- **systemd unit** `yuktiops-agent.service`:
  - `Restart=always`, `RestartSec=5`, `WantedBy=multi-user.target` (starts on boot)
  - `User=yuktiops`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=read-only`, `PrivateTmp=yes`
  - `MemoryMax=64M`, `CPUQuota=10%` (hard caps; the target is under 25 MB / 1%)
- Logs go to journald. The terminal is never occupied.
- **Commands shown in the dashboard and docs:**

  ```
  yuktiops-agent status                     # friendly status
  sudo systemctl restart yuktiops-agent     # restart
  sudo journalctl -u yuktiops-agent -f      # live logs
  sudo yuktiops-agent doctor                # diagnose problems
  sudo yuktiops-agent uninstall             # remove completely
  ```

- **Docker opt-in:** reading `docker.sock` is root-equivalent. The wizard says so plainly ("This gives the agent read access to Docker; it only reads container stats"), and the installer adds `yuktiops` to the `docker` group only when the user ticks Containers.

### 3.5 Simple alerts (request 5)

- **Templates** (one click, editable):
  - "Server goes down"
  - "Disk almost full" (85%)
  - "CPU stays very high" (90% for 5 minutes)
  - "Memory almost full"
  - "Website is down"
  - "Website is slow" (over 3 seconds for 5 minutes)
  - "SSL certificate expires soon"
  - "Domain expires soon"
  - "Container stopped"
  - "Service stopped"
- **Plain-language editor:** "Alert me when **disk space used** is above **85%** for **5 minutes** on **all servers**, and send it to **Email, Telegram**." No "operator", "threshold" or "severity" jargon in the UI; those words stay in the API.
- **New organizations** start with three active rules: server down, disk almost full, and website down (the last only applies once a website exists).
- **"Where to send alerts"** (contacts): Email, Telegram (connected through our bot with a one-click link), Slack (incoming webhook), Discord (webhook) and Webhook (HMAC-signed, behind the existing SSRF guard in `backend/src/services/uptime.js`). Each has a **Send test** button.
- **Routing:** each rule picks its contacts; the default is "all contacts".
- **Evaluation** runs over stored time windows, so "for 5 minutes" really means 5 minutes. The existing incident state machine and notification outbox in `backend/src/services/workers.js` are kept.

### 3.6 Team access (request 6)

- **Three roles:**
  - **Owner:** everything, including billing, plus deleting the organization and transferring ownership.
  - **Admin:** everything except billing and ownership.
  - **Viewer:** read-only.
  - `editor` is migrated to admin, and per-project scoping (`projectIds`) is removed from the UI and enforcement. There are no customers yet, so this migration is safe.
- **Invites:** a new `Invite` model (`email`, `role`, `tokenHash`, `invitedById`, `expiresAt` 7 days, `acceptedAt`, `revokedAt`).
  - An email with a link goes to `/invite/:token`.
  - New users set their name and password there; existing users click **Join**.
  - The email must match the invite, and the token is single-use.
  - Pending invites can be resent or cancelled.
- **Remove member:** keeps the existing `DELETE /members/:id` rules (the owner can't be removed, and you can't remove yourself). Removing a member revokes their sessions in that organization on their next request.
- **Plan member limits** are enforced on invite.

### 3.7 New frontend (replaces the old UI entirely)

- **Stack (fixed):** React + **JSX** (no TypeScript), Vite, **Tailwind CSS v3** (latest 3.4.x, with `tailwind.config.js`, `postcss.config.js` and `tailwindcss-animate`) and **shadcn/ui** added with the v3-compatible CLI (`npx shadcn@2.3.0 init|add`, `components.json` has `"tsx": false`). React Query, React Router and Recharts stay.
  - The brief said "v4" but every concrete instruction is v3 (`tailwind.config.js`, `shadcn@2.3.0`, "no `@theme` blocks, no `tw-animate-css`"), so v3 is used. No `@import "tailwindcss"` anywhere.
- **Theme:** all colours, radius, fonts and shadows are CSS variables in one file (`frontend/src/index.css`: `:root` and `.dark`), mapped in `tailwind.config.js`. Components use only the variables. The tweakcn export (`@theme.css`) was not found in the workspace, so the stock shadcn neutral variables are a placeholder; pasting the export over those two blocks restyles everything.
- **Light and dark** with a toggle (`.dark` class, remembered, defaults to the system setting).
- **Look:** modern, clean, professional SaaS; responsive down to 375 px; plain language; status always uses a word as well as a colour; every empty state has one next action.
- The old frontend (`frontend/src/**`, `ui.jsx`, the 3000-line stylesheet) is deleted once the new one replaces it.

---

## 4. Architecture (updated)

```
 customer server                               our infra (start: 1 VPS)
 ┌──────────────────┐ HTTPS /v1/register        ┌───────────────────────────────────────┐
 │ yuktiops-agent   │ HTTPS /v1/ingest (30s,gz) │ Caddy (TLS) → Node API (Express)      │
 │ (Go, systemd,    │ ◀── config version ────── │              ↕                        │
 │  user yuktiops)  │                           │ PostgreSQL 16 + TimescaleDB           │
 └──────────────────┘                           │ Node worker (alerts, checks, notify)  │
 websites / APIs ◀── HTTP/SSL/RDAP checks ──────└───────────────────────────────────────┘
 get.yuktiops.com + downloads.yuktiops.com = Cloudflare R2   (built by GitHub Actions + GoReleaser)
 app.yuktiops.com = React dashboard   ·   yuktiops.com = Astro site + docs
```

Unchanged from v1:

- Node/Express/Prisma/Zod backend, split into API and worker processes
- TimescaleDB with raw 30-second data, 5-minute and 1-hour rollups, and per-plan retention
- Hosting on a Hetzner VM, with Cloudflare and pgBackRest
- An Astro marketing site

Changed: per-server enrollment tokens become the account API key (3.1); the agent pulls config and reports diagnostics; release hosting is on R2.

## 5. Pricing (unchanged seed data; yours to decide)

|                   | Free            | Starter     | Pro         | Business  |
| ----------------- | --------------- | ----------- | ----------- | --------- |
| USD / INR per month | $0 / ₹0       | $9 / ₹599   | $29 / ₹1,999 | $99 / ₹6,999 |
| Servers included  | 2               | 3           | 10          | 40        |
| Website checks    | 5 (5-min)       | 25 (1-min)  | 100 (1-min) | 500 (30s) |
| History           | 7 days          | 30 days     | 90 days     | 1 year    |
| Alert contacts    | Email, Telegram | All         | All         | All       |
| Team members      | 1               | 3           | 10          | Unlimited |

---

## 6. Phases (small, each one testable on its own)

**Phase 0 — Cleanup and security baseline.** ✅ Done.

**Phase 1 — Account API key, registration and metric storage** (backend only) — ✅ **Done.** Beyond this list: `/api/agent-configs` (create, list, update) lets the wizard save setup profiles later; `DELETE /api/resources/:id` on a server also disconnects its agent; the dashboard's "Connect a server" dialog was adapted to the API key as an interim step until the Phase 5 wizard.

- Add the `ApiKey`, `AgentConfig` and `AgentEvent` models, the Timescale extension, a `server_metrics` hypertable, 5-minute and 1-hour continuous aggregates, and per-plan retention. Drop `AgentEnrollmentToken`.
- Endpoints:
  - `POST/DELETE /api/api-key` (create/regenerate/revoke; owner and admin only)
  - `POST /v1/register` (key + fingerprint → per-server credential, de-duplicated)
  - `POST /v1/ingest` (gzip JSON, Zod-validated, size-limited; responds with the config version)
  - `GET /v1/config`
  - `POST /v1/install-events`
- Remove manual server creation (`POST /api/resources` with type `server`) and the enrollment-token routes.
- Update `backend/scripts/agent.mjs` to the new protocol, so the backend can be tested before the Go agent exists.
- _Done when:_ tests cover key show-once/regenerate/revoke, register de-duplication, the plan limit on register, ingest auth, a revoked server being rejected, and the retention policy existing. One key registers 3 servers.

**Phase 2 — Go agent and background service**

- `agent/`: collectors for CPU, RAM, swap, disk per mount, disk I/O, network per interface, load, uptime and top 10 processes.
- 15-minute offline buffer, backoff with jitter, HTTPS only, `HTTPS_PROXY` support, config pull, and error reporting.
- CLI: `run`, `register`, `status`, `doctor`, `uninstall`, `version`. The systemd unit as in 3.4.
- _Done when:_
  - On WSL2 Ubuntu (systemd on) or a VPS, the agent survives a reboot and runs as `yuktiops`.
  - It stays under 25 MB RSS and under 1% CPU over 24 hours.
  - A 10-minute backend outage back-fills.
  - `doctor` correctly reports blocked HTTPS, a wrong clock and a revoked credential.

**Phase 3 — Builds, downloads and install script**

- GoReleaser and GitHub Actions on `agent/v*` tags: linux amd64, arm64 and armv7 as tar.gz, deb and rpm, plus a Docker image, `checksums.txt` and a cosign signature.
- Upload to R2, a smoke-test install, then a `latest.json` flip.
- `install.sh` as in 1.4, with `--uninstall`. `GET /api/agent/releases`. Local `npm run agent:dist` plus `/downloads` for development.
- _Done when:_ fresh Ubuntu 22.04/24.04, Debian 12 and Rocky 9 (amd64, plus one arm64) go from install to first data in under 2 minutes; a tampered tarball is refused; re-install doesn't duplicate; uninstall leaves nothing behind.
- _Needs from you:_ a Cloudflare account with R2 and the `get.` and `downloads.` DNS records. Until then, local `/downloads` works.

**Phase 4 — New frontend foundation** (replaces the old "new design" phase; no mockup round, the stack and theme are fixed in 3.7)

- Fresh `frontend/`: Vite + React JSX, Tailwind v3, shadcn (v3 CLI), theme variables, dark-mode toggle, API/session/query libs, app shell (sidebar from section 2, top bar with **Add server**, mobile drawer), shared components, and a route table with a page stub for every section. Project and environment pickers hidden; Agents page gone.
- _Done when:_ `npm run build` passes; sign-in/register work against the existing API; light/dark toggle works; usable at 375 px; no Tailwind v4 syntax anywhere; old UI deleted.

**Phase 5 — "Add server" wizard** (one flow replaces all connect buttons)

- Steps:
  1. **Where does it run?** Ubuntu/Debian, RHEL/Rocky/Alma/Amazon Linux, Other Linux, Docker, or "I only have shared hosting", which goes to Websites. Windows and macOS show "coming soon".
  2. **What do you want to monitor?** System health (always on), Docker containers, web server, databases, or specific processes.
  3. **Review settings:** a simple form, with "Show config file" for the YAML. Both stay in sync.
  4. **Install:** tabs for One command (recommended), Download (packages + `agent.yaml`) and Docker. API key handling as in 3.1.
  5. **Waiting for your server…:** live checklist → "Connected!" → server page.
- _Done when:_ Playwright covers signup → wizard → (simulated agent) → connected for each tab; there's no other "connect" entry point left.

**Phase 6 — Connection status and troubleshooting**

- The Connection tab and the error catalog from 3.3, plus the install-events timeline.
- The dashboard shows the status, restart, logs, doctor and uninstall commands.
- _Done when:_ every catalog error shows a plain-language fix; tests cover blocked network (no data), revoked key, plan limit, clock skew and a collector permission error.

**Phase 7 — Servers section with charts**

- A servers list (status, CPU/RAM/disk mini-bars).
- A server detail page with 1h/24h/7d/30d charts, disk and network breakdowns and top processes.
- Server settings (rename, edit config, remove).
- _Done when:_ chart queries on 30 days of data take under 300 ms; all 4 ranges are e2e-tested.

**Phase 8 — Alerts made simple**

- Templates, the plain-language editor, the "Where to send alerts" contacts (Email, Telegram, Slack, Discord, Webhook) with test-send, per-rule routing, time-window evaluation, the built-in offline rule and default rules.
- _Done when:_ a 4-minute spike doesn't fire a 5-minute rule; offline alerts within 3 minutes; all 5 contact types deliver a test message; tests cover fire, recover, flap and cooldown.

**Phase 9 — Team access**

- Three roles, migrating `editor` to admin and dropping `projectIds` enforcement.
- The invite model, email, accept page, resend and cancel; remove member; plan member limits.
- _Done when:_ e2e covers owner invites → the invitee accepts (new and existing user) → the viewer can't edit → admin removes the member and their access ends.

**Phase 10 — Websites & APIs**

- A concurrent check pool, retry before marking down, keyword checks, API checks (method, headers, expected status), SSL expiry and domain expiry (RDAP), with warnings at 30, 14 and 7 days.
- A redesigned section, and a checks-only onboarding path.
- _Done when:_ 200 monitors finish within their interval and a down site alerts within 2 intervals.

**Phase 11 — Containers (Docker)**

- An opt-in Docker collector: container list, state, restarts, CPU and memory per container.
- The Containers section, and the "Container stopped" template.
- _Done when:_ starting and stopping a container shows up within 1 minute and alerts.

**Phase 12 — Services**

- systemd service state, process-by-name checks, local port checks, nginx/Apache status (`stub_status` / `server-status`), and Redis/MySQL/Postgres "up and responding". Deep database metrics come later, with local secrets.
- _Done when:_ stopping nginx or MySQL shows "Stopped" and alerts within 1 minute.

**Phase 13 — Marketing site, docs and account emails**

- An Astro site (landing, features, pricing in INR and USD, docs including the troubleshooting pages, legal).
- Email verification and password reset.
- _Done when:_ Lighthouse scores 90+ and landing → connected server takes under 5 minutes.

**Phase 14 — Production launch (free beta).** Same as v1: Hetzner, Caddy, Cloudflare, backups and a restore drill, our own monitoring, deploy and rollback, and a 500-agent load test.

**Phase 15 — Billing.** Same as v1: Razorpay (INR, GST) and Stripe (USD), idempotent webhooks.

**Later:**

- Windows and macOS agents
- apt/yum repositories, signed auto-update
- Public status pages
- Multi-region checks
- Read API and Prometheus export, PagerDuty and Opsgenie
- Log tail

## 7. Assumptions (tell me to change any)

- Linux only at launch (amd64, arm64, armv7). Windows and macOS later.
- One active API key per organization; it registers servers only and never reads data.
- Per-project access control is dropped from the UI; one default project per organization.
- Downloads are hosted on Cloudflare R2 under `get.` and `downloads.yuktiops.com`; GitHub Releases is a mirror.
- The agent never runs remote commands; remote config only toggles built-in, read-only collectors.

## 8. Recommended order to start

Superseded by section 9 (agents and waves). Phases 0 and 1 are done.

## 9. Build plan: agents, ownership and order

Each agent edits only the files it owns. Frontend agents: **Tailwind v3 only, JSX only, shadcn from the v3 CLI only, colours only from the theme variables.** Backend agents publish their API contract to `docs/api/<area>.md` first so the frontend can build against it. Each uses its own test database (`TEST_DATABASE_URL`).

| Wave | Agent | Phases / tasks | Owns | Waits for |
| ---- | ----- | -------------- | ---- | --------- |
| 1 | **F: Frontend foundation** | 4 | `frontend/` except the page folders below | — |
| 1 | **B1: Backend core** | 6, 7 (API), 9, account emails (13), `/api/agent/releases` | routes `servers`, `team`, `account`, `connection`; services `agent-errors`, `invites`, `mail`; members part of `control.js` | — |
| 1 | **B2: Backend alerts + websites** | 8, 10 | routes `alerts`, `contacts`, `websites`; services `alerting`, `contacts`, `checks`; alerts/uptime/notifications part of `control.js`; `worker.js` | — |
| 1 | **G1: Go agent + installer** | 2, 3 | `agent/`, `.github/workflows/agent*.yml`, `backend/src/routes/downloads.js` | — |
| 1 | **Ops: production files** | 14 (files only; real deployment needs your accounts) | `deploy/`, `Dockerfile`, `docker-compose.prod.yml` | — |
| 2 | **FE-A: Servers pages** | 6, 7, 11, 12 (UI) | `frontend/src/pages/{overview,servers,containers,services}/` | F, B1 contract |
| 2 | **FE-B: Wizard, auth, settings** | 5, 9 (UI), 13 (auth UI), 15 (UI) | `frontend/src/pages/{auth,settings,add-server}/` | F, B1 contract, G1 releases |
| 2 | **FE-C: Alerts + websites UI** | 8, 10 (UI) | `frontend/src/pages/{alerts,websites}/` | F, B2 contract |
| 2 | **M: Marketing site + docs** | 13 | `site/` | F (theme file) |
| 3 | **B3: Backend containers/services** | 11, 12 (API, rules) | routes and services for containers/services | B1, B2 |
| 3 | **G2: Agent collectors** | 11, 12 (Go) | `agent/internal/{docker,services}/` | G1 |
| 3 | **B4: Billing** | 15 (Razorpay/Stripe code, signed idempotent webhooks; live keys need you) | `routes/billing.js`, `services/billing*` | B1 |
| 4 | **QA** | end-to-end, accessibility, full customer journey, bug fixes | `e2e/`, tests | all |
