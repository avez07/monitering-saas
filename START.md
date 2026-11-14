# Start YuktiOps (and test Phase 0)

Run commands from the repository root. You need **Node.js 22.12+**, npm and **Docker Desktop**. Examples use PowerShell.

## 1. First-time setup

```powershell
Copy-Item .env.example .env        # only if you do not have a .env yet
docker compose up -d postgres mailpit
npm install
npm run db:generate
npm run db:migrate
```

`docker compose up` starts PostgreSQL (with the TimescaleDB extension available for Phase 1) on port 5432 and Mailpit (a fake inbox for alert emails) at http://localhost:8025. The `.env` values are local dummies.

> **Port 4000 busy?** If an older copy of the app is still running (for example from before this change), stop it first. Check with `Get-NetTCPConnection -LocalPort 4000 -State Listen`.

## 2. Run it

```powershell
npm run dev
```

Open **http://localhost:5173**, choose **Create an account**, and register. You land on the Overview with the Free plan (2 servers). There is no demo account any more.

- API health: http://localhost:4000/api/health
- Stop with **Ctrl+C**.

## 3. Connect a server (development agent)

1. Go to **Servers → Connect a server**, choose the project, and click **Generate install command**.
2. Run the command shown, in a second terminal at the repository root. It looks like:

```powershell
node backend/scripts/agent.mjs --enroll <one-time-token> --api http://localhost:4000
```

3. Within about 30 seconds your computer appears under **Servers** with CPU, memory and disk. The credential is saved in `%USERPROFILE%\.config\yuktiops\agent.env`, not in the project. Later starts only need `npm run agent`.

The agent refuses to send credentials over plain `http://` unless the server is `localhost`. The one-line installer for real servers comes in Phase 1.

## 4. Run the automated tests

```powershell
npm test            # 24 backend tests on a real PostgreSQL (database yuktiops_test, created automatically)
npm run build       # production frontend build
npm run test:ui     # 4 browser tests (Playwright; needs Google Chrome; starts its own API and dashboard)
```

If ports 4000/5173 are taken, run the browser tests on other ports. `APP_URL` must match the dashboard address:

```powershell
$env:PORT=4001; $env:FRONTEND_PORT=5174; $env:APP_URL="http://localhost:5174"; npm run test:ui
```

## 5. Manual security checks (about 5 minutes)

1. **Session is not in page storage.** After signing in, open browser DevTools → Application → Local Storage: no token is stored. Under Cookies, `yuktiops_session` shows **HttpOnly** ✓ and **SameSite=Lax**. In the Console, `document.cookie` does not list it.
2. **Logout really logs out.** Click the sign-out icon (bottom left), then press the browser Back button or reload: you are on the sign-in screen.
3. **Account lockout.** Try a wrong password 10 times for one email: the 11th attempt (even with the right password) says too many attempts. Another account still signs in fine.
4. **No demo login.** `Invoke-RestMethod -Method Post http://localhost:4000/api/auth/demo` returns 401/404, never a login.
5. **Team page.** **Team & access** has no "Add team member" button. Accounts are no longer created with admin-chosen passwords; invitations arrive in Phase 5.
6. **Alert notification.** On **Alerts**, add a rule (for example CPU above 1% for 60 seconds) with the agent running. Within about two minutes the incident fires and the message shows under **Alerts → Notification history** (status `local`: with the default `EMAIL_PROVIDER=local` nothing is actually emailed). To see real emails, set `EMAIL_PROVIDER=smtp` in `.env`, restart, and open Mailpit at http://localhost:8025.

## 6. Run the full stack in Docker

```powershell
docker compose --profile app up --build -d      # API + worker + dashboard
# if port 4000 is busy:  $env:API_HOST_PORT=4002; docker compose --profile app up --build -d
docker compose logs -f api worker
docker compose --profile app down               # stop (data is kept in the Docker volume)
```

Open http://localhost:4000 (or your `API_HOST_PORT`). Note `APP_URL` in `.env` must match the address you open (default `http://localhost:5173`), so for the Docker app set `APP_URL=http://localhost:4000` in `.env` first.

## Useful commands

| Command                       | What it does                                              |
| ----------------------------- | --------------------------------------------------------- |
| `npm run dev`                 | API, background worker and dashboard with live reload     |
| `npm run worker`              | Only the background worker (checks, alerts, cleanup)      |
| `npm run db:migrate`          | Apply database migrations                                 |
| `npm run db:seed`             | Insert/update the plan definitions (also runs at startup) |
| `npm run check`               | Tests + build + schema validation                         |
| `docker compose logs mailpit` | See captured alert emails                                 |

## Troubleshooting

- **Cannot connect to the database:** `docker compose up -d postgres`, then check `DATABASE_URL` in `.env`.
- **"Cross-site request blocked":** `APP_URL` in `.env` does not match the address in your browser.
- **Older Pulse data:** the previous setup used a different Docker volume (`monitering-saas_postgres-data`). It is untouched and no longer used; delete it yourself when you are sure you do not need it.
