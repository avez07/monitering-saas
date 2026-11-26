# The `deploy/` folder

Everything needed to **ship, protect and test** YuktiOps on a production server. The application code lives in
`backend/` and `frontend/`; this folder is about running it safely.

```
deploy/
├── common.sh            shared helper functions (sourced by the other scripts, never run directly)
├── deploy.sh            release a new version, with automatic rollback if it goes wrong
├── rollback.sh          go back to the previous version by hand
├── Caddyfile            the gateway config when Caddy owns ports 80/443
├── Caddyfile.traefik    the gateway config when Traefik already owns 80/443 (SNI passthrough)
├── sites.caddy          the app / api / otlp / docs site blocks, shared by both Caddyfiles
├── postgres/            custom database image (TimescaleDB + pgBackRest) and its backup config
├── backup/              backup, backup health check, restore drill, Redis snapshot, cron schedule
└── loadtest/            simulates thousands of agents to find the system's limits
```

Paths below assume the server layout `/opt/yuktiops`, with `.env.production` next to
`docker-compose.prod.yml`.

---

## 1. `deploy.sh` and `rollback.sh`: releasing without downtime

### Problem solved
A plain `docker compose up -d --build` on a live server has several risks:

- It restarts everything at once, so users see an outage.
- A database migration can run with no backup behind it. If it breaks data, there is no way back.
- A new version that crashes on start stays live until someone notices.
- Nobody knows which version is running or which one to go back to.

### What `deploy.sh` does
Run `deploy/deploy.sh` and it works through these steps in order. It stops at the first one that fails.

| Step | What happens | Problem it prevents |
|---|---|---|
| 1. Build | Builds the `api`, `web` and `db` images tagged with the git commit (for example `a1b2c3d4e5`) | You always know exactly which code is running |
| 2. Backup gate | `backup/check.sh` must pass, then an incremental backup is taken | Never migrate the database without a restorable backup |
| 3. Migrate | Runs `prisma migrate deploy` in a one-off container on the **new** image, straight to Postgres | A failed migration stops the release, and **the running version is not touched** |
| 4. Rolling restart | Restarts `api` (2 replicas), then each worker, then `web`, waiting for each to be healthy | No outage: Caddy only sends traffic to healthy replicas |
| 5. Smoke test | Calls `HEALTH_URL_API` and `HEALTH_URL_APP` from `.env.production` | Catches a release that is healthy inside Docker but broken from outside |
| 6. Auto rollback | If step 4 or 5 fails, the previous tag is started again | A bad release fixes itself in about a minute |
| 7. Clean up | Keeps the last few images for fast rollback and removes older ones | Disk fills up with old images |

### Example: a normal release
```bash
cd /opt/yuktiops
git pull
deploy/deploy.sh
```
Typical output:
```
2026-11-25T10:00:01Z deploying tag a1b2c3d4e5 (currently running: 9f8e7d6c5b)
2026-11-25T10:02:10Z taking pre-deploy incremental backup
2026-11-25T10:02:40Z running migrations
2026-11-25T10:03:30Z release a1b2c3d4e5 is live
```

### Example: a release that breaks
The new version crashes on start, so `api` never becomes healthy:
```
RELEASE FAILED: a service did not become healthy on a1b2c3d4e5
rolling back to 9f8e7d6c5b
ERROR: rolled back to 9f8e7d6c5b. Schema stays migrated
```
Users stay on the old version. You read `docker compose logs api`, fix the bug and deploy again.

### Example: roll back by hand
The release looked fine but you found a bug an hour later:
```bash
deploy/rollback.sh            # to the previous release
deploy/rollback.sh 9f8e7d6c5b # or to any release still on the host
```
It starts the old image without rebuilding, so it takes seconds.

### Options
| Command | Meaning |
|---|---|
| `deploy.sh` | Build and release the current commit. Refuses a dirty git tree |
| `deploy.sh v1.4.0` | Release with an explicit tag |
| `deploy.sh --pull` | Pull images from a registry instead of building |
| `deploy.sh --no-build` | Use images already on the host, such as ones built in CI |
| `deploy.sh --skip-backup-check` | Skip the backup gate. Only for emergencies |

### Important rule: rollback does not undo the database
Rollback restarts the old code on the **already migrated** database. So each migration must work with both the old
and the new code. Add a column in one release, and remove the old one in a later release ("expand, then
contract"). If a migration damaged data, restore from backup instead (see section 3).

### What `common.sh` provides
Small shared functions: `dc` (docker compose with the right files), `wait_healthy` (wait until a container's
health check passes), `roll_to` (restart everything on a tag, one service at a time), `smoke_test`,
`record_release` (writes the current and previous tags into `.deploy/`). `.deploy/release.env` pins
`APP_TAG`, so a later plain `docker compose up -d` can never silently jump to `:latest`.

### Small servers (about 4 GB RAM)
Add swap first, then run with `docker-compose.small.yml` as the last override and `API_REPLICAS=1`:
```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
export COMPOSE_OVERRIDE="docker-compose.traefik.yml docker-compose.disk-backup.yml docker-compose.small.yml"
```
Suitable for testing and light load. Use 8 GB or more for real customer traffic.

---

## 2. `Caddyfile`, `Caddyfile.traefik` and `sites.caddy`: the gateway

### Problem solved
Four hostnames must reach different places with HTTPS, rate-limit-friendly client IPs and safe defaults, without
exposing internal endpoints.

| Host | Goes to |
|---|---|
| `app.yuktiops.com` | The dashboard (static files), and `/api`, `/v1`, `/downloads` to the API |
| `api.yuktiops.com` | The agent endpoint (agents send data here) |
| `otlp.yuktiops.com` | OpenTelemetry ingest, only the three OTLP paths |
| `doc.yuktiops.com` | The documentation site (static files) |

What Caddy does here:

- Gets and renews Let's Encrypt certificates automatically.
- Adds security headers (HSTS, CSP and others).
- Spreads requests across the API replicas and skips unhealthy ones.
- Answers `404` for `/metrics` and `/admin` on every host, so internal pages can never leak.
- Limits request body sizes.

### Which Caddyfile do I use?
- **`Caddyfile`**: Caddy owns ports 80/443. This is the default.
- **`Caddyfile.traefik`**: Traefik already owns 80/443 and forwards only the yuktiops hostnames to Caddy as raw
  TCP. Start it with `docker-compose.traefik.yml`. Full steps: [../docs/deploy-behind-traefik.md](../docs/deploy-behind-traefik.md).

Both import `sites.caddy`, so you edit a site in one place.

### Example: add a new subdomain
Add this to `sites.caddy`, add `STATUS_DOMAIN` to `.env.production` and the compose `web` environment, and add a DNS record:
```caddy
{$STATUS_DOMAIN} {
	import security_headers
	root * /srv/status
	file_server
}
```
Then reload without downtime: `docker compose exec web caddy reload --config /etc/caddy/Caddyfile`.

---

## 3. `postgres/` and `backup/`: not losing data

### Problem solved
Servers die, disks fail, a bad migration or a mistaken `DELETE` can destroy data. A backup that was never tested
is not a backup. This folder makes backups automatic, off-site, encrypted and **proven to restore**.

### `postgres/`
- `Dockerfile`: TimescaleDB on Postgres 16 with `pgBackRest` installed, so backups run next to the data.
- `pgbackrest.conf`: the fixed settings. Secrets come from environment variables. It stores backups in
  Cloudflare R2 (S3-compatible), keeps 4 full and 7 differential backups, and encrypts client-side with AES-256,
  so R2 only ever sees ciphertext.

Postgres also archives each WAL segment (its change log) every 60 seconds at most. A full backup plus the WAL
lets you restore **to any second**, not just to the last night's backup. This is point-in-time recovery.

### `backup/` scripts
| Script | What it does | Problem it solves |
|---|---|---|
| `setup.sh` | One time: creates the pgBackRest stanza, checks archiving works, takes the first full backup | Backups silently never working |
| `backup.sh full\|incr` | Takes a full or incremental backup | Regular off-site copies |
| `check.sh` | Fails if the newest backup is older than 26 hours or WAL archiving is broken | Finding out a backup stopped working months later. `deploy.sh` runs it before every migration |
| `restore-drill.sh` | Restores the latest backup (or a point in time) into a **throwaway** container, verifies it and reports how long it took | Not knowing whether a restore works or how long recovery takes |
| `redis-snapshot.sh` | Copies a fresh Redis dump to R2 | Quicker recovery of in-flight jobs. Postgres is the system of record, Redis is rebuildable |
| `cron.example` | The schedule | Backups depending on someone remembering |

### The schedule in `cron.example`
| When | Job |
|---|---|
| Sunday 02:15 | Full backup |
| Monday to Saturday 02:15 | Incremental backup |
| Every hour | `check.sh` mails you when backups are stale |
| First Saturday of the month | Restore drill |
| Every 6 hours | Redis snapshot |

### Backups on a disk instead of R2
No R2 bucket yet? Store the repository on a mounted disk. It is still encrypted and still supports point-in-time recovery.
```bash
sudo mkdir -p /mnt/backup/yuktiops && sudo chown 70:70 /mnt/backup/yuktiops && sudo chmod 700 /mnt/backup/yuktiops
# .env.production:  BACKUP_REPO_TYPE=posix   BACKUP_DIR=/mnt/backup/yuktiops   PGBACKREST_CIPHER_PASS=<openssl rand -hex 32>
export COMPOSE_OVERRIDE="docker-compose.traefik.yml docker-compose.disk-backup.yml"   # add to ~/.bashrc too
docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml -f docker-compose.disk-backup.yml --env-file .env.production up -d db
deploy/backup/setup.sh
```
`70` is the `postgres` user inside the db image. Use a different physical disk than the database, or copy the
directory off the server regularly (`rsync`), because a backup on the same disk does not survive that disk dying.
`redis-snapshot.sh` needs R2 and is skipped in this mode (Redis data is rebuildable).

### Example: first-time setup (R2)
```bash
# 1. fill R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, PGBACKREST_CIPHER_PASS
#    in .env.production. Keep the cipher pass in a password manager: without it backups are unreadable.
docker compose -f docker-compose.prod.yml --env-file .env.production up -d db
deploy/backup/setup.sh
sudo cp deploy/backup/cron.example /etc/cron.d/yuktiops-backup
deploy/backup/restore-drill.sh        # prove it works before launch
```

### Example: someone ran `DELETE FROM Server` at 10:30
```bash
# test the recovery first, in a throwaway container, to a moment just before the mistake
deploy/backup/restore-drill.sh --target-time "2026-11-25 10:29:00+00"
```
The drill shows the data is there and how long the restore takes. The production recovery steps are in
`docs/runbook.md` ("bad migration / data loss").

---

## 4. `loadtest/`: knowing the limits before customers find them

### Problem solved
You do not know how many servers the system can monitor until something breaks. `loadtest.mjs` simulates
many agents sending gzip data batches and reports where the pipeline slows down.

It measures:

- Ingest **queue lag** (`yuktiops_ingest_lag_seconds`, max and p99) and the peak number of waiting jobs.
- **Data loss**: after the run it waits for the queue to drain, then compares rows in the database with the rows the API accepted.

### Example
```bash
# 500 agents for 5 minutes against a local API
node deploy/loadtest/loadtest.mjs --api http://localhost:4020 --agents 500 --duration 300

# 5000 agents across two API instances, with queue-lag readings
node deploy/loadtest/loadtest.mjs --apis http://localhost:4020,http://localhost:4021 \
  --agents 5000 --duration 1800 --metrics-token $METRICS_TOKEN
```

### Safety
- It registers hundreds of fake servers and writes many rows, so it refuses to run against anything but
  localhost unless you pass `--i-know-this-is-not-production`.
- `raise-limits.sql` lifts the free plan's 2-server cap so one test account can hold a big fleet.
  **Local test databases only. Never run it against production.**

---

## How the pieces fit: a release day

1. `git pull` on the server.
2. `deploy.sh` checks the **backup** is fresh (`backup/check.sh`), takes a pre-deploy backup, runs migrations,
   then restarts services one by one while the **gateway** (Caddy) only routes to healthy ones.
3. If anything fails, `deploy.sh` rolls back automatically. If you notice later, `rollback.sh` does it by hand.
4. Cron keeps backups flowing, checks them every hour and rehearses a restore every month.
5. Before a big customer onboards, `loadtest.mjs` shows whether the system copes.

See also: `docs/ops.md` (releases and scaling), `docs/runbook.md` (incidents), `docs/deploy-behind-traefik.md`.
