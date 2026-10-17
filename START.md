# Start Pulse

Run commands from the repository root. Node.js **22.12+** and npm are required. The supplied `.env` contains dummy local credentials. Do not paste service credentials into frontend source files.

## 1. Quick start — no Docker required

```powershell
npm install
npm run dev
```

Open **http://localhost:5173** and click **Explore the demo workspace**. Alternatively, sign in using `DEMO_EMAIL` and `DEMO_PASSWORD` from `.env`.

- Frontend: http://localhost:5173
- Backend health: http://localhost:4000/api/health
- Stop: press **Ctrl+C** in the terminal running the app.
- Metadata persists in `backend/data/demo.json`. Telemetry charts, logs, and traces are sample data. Demo OTLP requests are authenticated and metered, then discarded.
- The seed creates ten isolated pilot organizations with separate owners. Only the first belongs to the main demo user.

If `.env` is missing:

```powershell
Copy-Item .env.example .env
```

Copy it only when missing; overwriting an existing file would replace your configuration and agent token.

## 2. Connect your local computer

1. Open **Agents → Connect agent**.
2. Select the project and generate an installation token.
3. Inspect `backend/scripts/agent.mjs`.
4. Run the generated command in a second terminal, from this repository root.

```text
node backend/scripts/agent.mjs --enroll <one-time-token-from-the-app>
```

The agent enrolls once, saves `AGENT_TOKEN` to `.env`, and reports host measurements. Later starts need only:

```powershell
npm run agent
```

Keep the agent terminal running. It reports every 30 seconds. Stop with Ctrl+C. In demo mode, inventory shows actual heartbeat measurements while historical charts remain labeled sample data. Use connected mode for stored telemetry. See [collector integrations](docs/AGENTS.md) for full host metrics, container/exporter integrations, and application SDKs.

## 3. Connected mode — PostgreSQL and real telemetry

Start Docker Desktop first. Keep the app stopped while changing modes.

```powershell
docker compose up -d
```

Wait for storage services to become ready. Change this value in the root `.env`:

```dotenv
DEMO_MODE=false
```

Then run:

```powershell
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

Open http://localhost:5173, choose **Create an account**, and register your organization. Connected mode does not enable the public demo-login shortcut or create a known demo owner. Plan definitions are seeded automatically as well.

Enroll a fresh agent for the new workspace; a demo-store credential will not work against PostgreSQL. Ingestion and query paths now use Mimir, Loki, and Tempo. App traces/logs need a configured SDK or collector. PostgreSQL stores SaaS metadata only.

Useful local services:

| Service                | URL / address         |
| ---------------------- | --------------------- |
| Internal Grafana       | http://localhost:3001 |
| Object-storage console | http://localhost:9001 |
| Mailpit inbox          | http://localhost:8025 |
| PostgreSQL             | localhost:5432        |
| Redis                  | localhost:6379        |

Grafana and S3/RustFS credentials are in `.env`. Grafana's provisioned data sources use the `internal` telemetry tenant; customer project tenant IDs are different. Configure an operations-only data source for a specific project when diagnosing it. Customers use the React app.

Email defaults to a local database outbox. To test SMTP through Mailpit, set `EMAIL_PROVIDER=smtp` in `.env`, keep the provided SMTP host/port, and restart the backend. Local mode never sends mail. Billing stays simulated until a real provider adapter is implemented.

## 4. Build and serve from one Node process

```powershell
npm run build
npm start
```

Open **http://localhost:4000**. The backend serves the built frontend and API. Stop the previous development API first because it uses the same port. For browser-based installers on another host, set `API_PUBLIC_URL` to the reachable API URL, not localhost.

## 5. Run everything through Docker

```powershell
docker compose --profile app up -d --build
```

Open **http://localhost:4000** and register a new workspace. The app profile explicitly uses connected mode and container network endpoints. Database migrations run at container startup. Docker Compose is a local development deployment with dummy credentials and no TLS termination; see [operations](docs/OPERATIONS.md) for deployment changes.

Inspect status and logs:

```powershell
docker compose ps
docker compose logs --tail 100 app mimir loki tempo
docker compose down
```

`down` stops services and retains named volumes. Do not add `--volumes` unless you intend to delete persisted data.

## 6. Verification commands

```powershell
npm test
npm run build
npm run db:validate -w backend
npm run test:ui
```

Browser tests use installed Google Chrome. If Chrome is unavailable, install Playwright's Chromium using `npx playwright install chromium` and remove `channel: 'chrome'` from `playwright.config.js`.

With connected-mode Docker dependencies running, `npm run test:connected` applies migrations to a separate `pulse_integration` database and verifies registration, agent enrollment/heartbeat, real metrics/log/trace storage and query, and tenant isolation. It creates test fixtures and does not delete your main database.

With the demo API running, measure a small ten-tenant control-plane workload:

```powershell
npm run load-test
```

Results are saved in `docs/verification/load-result.json`. This does not benchmark the telemetry storage stack. See [capacity planning](docs/CAPACITY.md).

## Troubleshooting

- **Port in use:** stop the existing app terminal. The defaults are frontend 5173 and API 4000. Configure `FRONTEND_PORT`, `PORT`, `APP_URL`, and `API_PUBLIC_URL` in `.env`; the Vite proxy reads the backend port from that file.
- **API unavailable:** run `npm run dev` from the root and check backend output.
- **Expired token:** generate a new installation token. Each lasts 15 minutes and can be used once.
- **401 after changing modes:** sign out, register/sign in in the new mode, and enroll a new agent.
- **Prisma engine missing:** allow Prisma's tooling download, then rerun `npm run db:generate`. On npm versions that block lifecycle scripts, the explicit generate command handles client generation.
- **Docker pipe/daemon unavailable:** start Docker Desktop in Linux-container mode and rerun `docker compose up -d`.
- **Telemetry service unavailable:** check Docker logs. The app reports the error instead of substituting sample data in connected mode.
- **Empty live charts:** wait for export intervals and ensure the exporter sends the documented metric names. The lightweight Node agent uses `pulse.host.*`; overview host charts also support the standard OpenTelemetry hostmetrics receiver.
