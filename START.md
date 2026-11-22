# Start YuktiOps

Run every command from the repository root. You need **Node.js 22.12+**, npm and **Docker Desktop**. Examples use PowerShell; they work the same in Bash unless noted.

## Ports

| Port | What                                      | Where                                  |
| ---- | ----------------------------------------- | -------------------------------------- |
| 5173 | Dashboard (Vite dev server, proxies /api) | http://localhost:5173                  |
| 4000 | API (`/api`, agent protocol `/v1`)        | http://localhost:4000/api/health       |
| 5432 | PostgreSQL + TimescaleDB (Docker)         | `postgresql://yuktiops@localhost:5432` |
| 1025 | Mailpit SMTP (Docker)                     | where every email is sent in dev       |
| 8025 | Mailpit inbox (Docker)                    | http://localhost:8025                  |
| 8428 | VictoriaMetrics (Docker, premium metrics) | http://localhost:8428/health           |
| 4321 | Marketing site (`npm run site:dev`)       | http://localhost:4321                  |

The browser tests use their own API on **4060** and the database `yuktiops_e2e`; the backend tests use `yuktiops_test`. Neither touches your development data.

## 1. First-time setup

```powershell
Copy-Item .env.example .env        # only if you do not have a .env yet
docker compose up -d postgres mailpit victoriametrics
npm install
npm run db:generate
npm run db:migrate
```

**After pulling new code**, run `npm install`, `npm run db:migrate` and `npm run db:seed` (new tables and plan features, for example the premium advanced metrics and platform admin).

`.env` holds local dummy values only. `APP_URL` must match the address you open in the browser (default `http://localhost:5173`), or the API answers "Cross-site request blocked".

## 2. Run it

```powershell
npm run dev          # API + background worker + dashboard, all with live reload
```

Open **http://localhost:5173**. Stop with **Ctrl+C**.

**Separate terminals (Backend, Worker, Frontend each in its own window):** run one command per terminal, from the repo root:

```powershell
npm run dev:backend    # terminal 1: API on :4000
npm run dev:worker     # terminal 2: background worker (checks, alerts, email)
npm run dev:frontend   # terminal 3: dashboard on :5173
```

Or open all three at once: `npm run dev:terminals` (Windows: `scripts/dev-terminals.ps1`, uses Windows Terminal tabs if `wt` exists; Linux/macOS: `scripts/dev-terminals.sh`, uses tmux or a terminal window each). `npm run dev:all` is the combined single-stream alias of `npm run dev`. If a port is busy, set `PORT` / `FRONTEND_PORT` in `.env` (and keep `APP_URL`, `API_PUBLIC_URL` consistent).

## 3. Try it as a brand-new customer

1. **Sign up** at http://localhost:5173/register (name, company, email, password of 10+ characters). You land on an empty **Overview** with the Free plan (2 servers, 2 team members).
2. **Verify your email.** A banner at the top says the address is not verified yet. Open http://localhost:8025 (Mailpit), open "Confirm your YuktiOps email" and click the link, or press **Resend email** in the banner.
3. Click **Add your first server** and follow the five steps: where it runs, what to monitor, review, install, connect. In the install step choose **Create API key** (shown once; copy it) and note the command.
4. **Connect a machine**, either the development agent (a Node script that speaks the real protocol) or the real Go agent (see section 4). The wizard flips to **Connected!** within a minute.
5. Open the server: charts for 1 hour, 24 hours, 7 days and 30 days, the **Connection** tab (what we can hear, plain-language fixes) and **Settings**.
6. **Alerts**: add one **from a template**; under **Where to send alerts** add an email contact and press **Send test**. The message arrives in Mailpit.
7. **Websites & APIs**: add a website. Checks run from the worker (every 30 s in dev, set `WORKER_INTERVAL_MS`). Private and loopback addresses are blocked on purpose (see the note below).
8. **Settings → Team**: invite a colleague as Viewer. The invitation email (with the link) appears in Mailpit. Open it in a private window, create the account, and check that a Viewer cannot change anything. Remove them again and their access ends immediately.
9. **Settings → API key**: regenerate it (old install commands stop working; connected servers keep running). Try the theme toggle (sun/moon icon), shrink the window to phone width for the menu button, and sign out from the avatar menu.

**Platform admin (YuktiOps staff).** Create a staff user with `npm run admin:create -- you@example.com` (prints a one-time random password; add `--password <pw>` to choose one, or run it on an existing account to promote it). Sign in and open **http://localhost:5173/admin** (also linked from the avatar menu): overview, organizations (change plan, suspend, reactivate), users and the audit log. Remove the flag with `npm run admin:revoke -- you@example.com`.

> Monitoring `localhost` from the website monitor is refused (SSRF protection). To try it locally, start the API with `E2E_ALLOW_LOOPBACK=1` (never honoured in production).

## 4. Run an agent against your local API

**Development agent (fastest, no build):** copy the command from the wizard's install step, but run the Node script instead:

```powershell
node backend/scripts/agent.mjs --register --key yk_live_<your-key> --api http://localhost:4000
```

It keeps only its own per-server credential in `%USERPROFILE%\.config\yuktiops\agent.env`. Later starts: `npm run agent`. Registering again on the same machine reconnects the same server (no duplicate). Use `YUKTIOPS_CONFIG_DIR=<folder>` to run several agents from one machine.

**The real Go agent and installer** (Linux target; use WSL2 or a Linux VM, or the Docker option):

```powershell
npm run agent:dist       # cross-compiles linux amd64/arm64/armv7 into backend/downloads/ (Go toolchain or Docker)
npm run agent:build      # one binary for this machine into agent/bin/
npm run agent:test       # go vet + go test (via Docker if Go is not installed)
```

The API then serves the downloads at http://localhost:4000/downloads/. On a Linux machine that can reach your computer:

```bash
curl -fsSL http://localhost:4000/downloads/install.sh | sudo bash -s -- \
  --key=yk_live_<your-key> --api=http://localhost:4000 --base-url=http://localhost:4000/downloads
```

(`http://` is accepted only for `localhost`.) Check it with `yuktiops-agent status` and `sudo yuktiops-agent doctor`; remove it with `sudo yuktiops-agent uninstall`.

**Docker option:** `docker run -d --name yuktiops-agent -e YUKTIOPS_API_KEY=yk_live_<your-key> -e YUKTIOPS_API_URL=http://host.docker.internal:4000 -v yuktiops-agent:/var/lib/yuktiops ghcr.io/yuktiops/agent`. If you get `denied`, the image is not public yet: build it locally with `docker build -t yuktiops-agent:local -f agent/Dockerfile agent` and use `yuktiops-agent:local` as the image (or `YUKTIOPS_API_KEY=yk_live_<your-key> docker compose --profile agent up -d --build`) (the wizard's **Docker** tab shows the exact command, including the local `--api`).

The free plan allows 2 servers; a third registration is refused with a message to upgrade.

## 5. Run the tests

```powershell
npm test             # backend: ~145 integration tests on a real PostgreSQL (database yuktiops_test, created automatically)
npm run build        # production dashboard build
npm run check        # tests + build + Prisma schema validation
npm run test:e2e     # browser tests: full new-customer journey and accessibility (axe) on every page, light and dark
npm run site:build   # marketing site
npm run loadtest     # 500 simulated agents; read the header of deploy/loadtest/loadtest.mjs first
```

`npm run test:e2e` needs Docker (`postgres` and `mailpit` up) and Google Chrome (or `E2E_CHANNEL= npx playwright install chromium`). It starts its own API, worker and dashboard (ports 4060 and 5173) and creates the database `yuktiops_e2e`; it reuses servers already running on those ports. Useful variables: `E2E_DATABASE_URL`, `E2E_API_PORT`, `E2E_WEB_PORT`, `E2E_MAILPIT_URL`. Reports of failures (screenshots, traces) go to `test-results/`.

## 6. Run the full stack in Docker

```powershell
docker compose --profile app up --build -d      # API + worker + dashboard on port 4000
docker compose logs -f api worker
docker compose --profile app down               # stop (data is kept in the Docker volume)
```

Set `APP_URL=http://localhost:4000` in `.env` first. If port 4000 is busy: `$env:API_HOST_PORT=4002`.

## Useful commands

| Command                       | What it does                                                |
| ----------------------------- | ----------------------------------------------------------- |
| `npm run dev`                 | API, worker and dashboard with live reload                  |
| `npm run dev:backend` / `dev:worker` / `dev:frontend` | One service per terminal              |
| `npm run dev:terminals`       | Opens the three above in separate terminals                 |
| `npm run worker`              | Only the background worker (checks, alerts, email, cleanup) |
| `npm run db:migrate`          | Apply database migrations                                   |
| `npm run db:seed`             | Insert/update plan definitions (also runs at API start)     |
| `npm run admin:create -- <email>` / `admin:revoke -- <email>` | Grant / remove platform admin (`/admin`) |
| `npm run agent`               | Start the saved development agent                           |
| `npm run site:dev`            | Marketing site with live reload                             |
| `npm run format`              | Prettier on the code                                        |
| `docker compose logs mailpit` | See captured emails (or open http://localhost:8025)         |

## Troubleshooting

- **Cannot connect to the database:** `docker compose up -d postgres`, then check `DATABASE_URL` in `.env`.
- **"Cross-site request blocked":** `APP_URL` in `.env` does not match the address in your browser.
- **No emails arrive:** make sure Mailpit is up (`docker compose up -d mailpit`) and `SMTP_HOST=localhost`, `SMTP_PORT=1025`.
- **Wizard stays on "Waiting":** run `yuktiops-agent doctor` (Go agent) or look at the agent's terminal; the **Connection** tab of the server explains what the API has heard.
- **Server shows "Offline":** nothing arrived for 90 seconds (three send intervals). Start the agent again.
- **Registration says "Too many attempts":** sign-up is limited to 10 per hour per address; restarting the API clears the in-memory counters in development.
