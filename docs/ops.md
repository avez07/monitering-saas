# YuktiOps operations guide (Phase 14)

Everything here is written and tested as files, but **nothing has been deployed**: a real launch needs your
Hetzner, Cloudflare and domain accounts (section 1). Section 9 holds the measured load-test results.

Contents: 1 What you must provide, 2 Topology, 3 First bring-up, 4 Server hardening, 5 Cloudflare and TLS,
6 Backups and restore drills, 7 Releases and rollback, 8 Monitoring ourselves, 9 Load test, 10 Launch checklist.

## 1. What you must provide

| Item | Why | Notes |
| --- | --- | --- |
| Hetzner Cloud account and one VM | Runs the whole stack | CPX31 (4 vCPU / 8 GB, x86) or CAX21 (4 vCPU ARM / 8 GB) is plenty for the first 1,000 servers. Ubuntu 24.04 LTS. Enable Hetzner backups (cheap, extra safety) |
| Domain `yuktiops.com` on Cloudflare | DNS, proxy/WAF, R2 | Records: `app`, `api` (A/AAAA to the VM). `get`/`downloads` belong to the agent release phase |
| Cloudflare R2 bucket + API token | pgBackRest repository | Bucket `yuktiops-pgbackrest`, token with Object Read and Write on that bucket only. Note the account endpoint `<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| SMTP relay credentials | Alert and account emails | SES, Postmark, Resend or Brevo. Publish SPF, DKIM and DMARC for the `EMAIL_FROM` domain |
| Secrets | `.env.production` | `POSTGRES_PASSWORD`, `BILLING_WEBHOOK_SECRET`, `PGBACKREST_CIPHER_PASS` (generate with `openssl rand -hex 24`/`32`; store the cipher pass in a password manager, it is the only way to read backups) |
| External uptime service | Independent "are we down" check | UptimeRobot, Better Stack or healthchecks.io (free tiers are enough) |
| Admin SSH key | Server access | Public key only; no password logins |
| Git remote with the code | `deploy.sh` builds from the checked-out commit | Optional: a container registry (GHCR) if you would rather build in CI |

No secrets live in this repository. `.env.production.example` contains `CHANGE_ME` placeholders only.

## 2. Topology

```
Internet -> Cloudflare (proxy, WAF, rate limits) -> VM :443
  web (Caddy: TLS, gzip, security headers)
    app.yuktiops.com  /            static React build (SPA fallback)
                      /api /v1 /downloads -> api:4000
    api.yuktiops.com  everything   -> api:4000   (agents, health checks)
  api    (Node, port 4000, internal only)      networks: edge + internal
  worker (Node, uptime checks/alerts/email)    networks: egress + internal
  db     (TimescaleDB on Postgres 16 + pgBackRest) network: internal only (no route out, no published port)
```

- One image (`yuktiops-app:<tag>`) runs both `api` and `worker` (different command); `yuktiops-web:<tag>` holds
  Caddy plus the built frontend, so a release is atomic and rolls back as a unit.
- Containers run read-only, with all Linux capabilities dropped, no-new-privileges, memory/CPU limits and
  `restart: unless-stopped`. Logs rotate (20 MB x 5).
- `TRUST_PROXY` must name the `edge` subnet (`172.29.0.0/24`, defined in `docker-compose.prod.yml`). Without it
  every client looks like one IP and rate limits hit everybody (or can be spoofed).
- The Postgres pool is set by `DB_POOL_SIZE` (default 20 per process) through the `connection_limit` URL
  parameter. Postgres `max_connections=100` leaves room for api + worker + migrations + backups.
- Scaling out later: the API's rate limiter is in-process memory (see section 9 findings), so run a single API
  replica until it moves to the database.

## 3. First bring-up

On a fresh Ubuntu 24.04 VM, after section 4 (hardening):

```bash
# 1. Docker (official repo), then the deploy user
sudo apt-get install -y ca-certificates curl gnupg jq git
curl -fsSL https://get.docker.com | sudo sh
sudo adduser --disabled-password --gecos "" deploy && sudo usermod -aG docker deploy
sudo mkdir -p /opt/yuktiops && sudo chown deploy:deploy /opt/yuktiops

# 2. As deploy: code + env
sudo -iu deploy
git clone <your repo url> /opt/yuktiops && cd /opt/yuktiops
cp .env.production.example .env.production && chmod 600 .env.production
$EDITOR .env.production        # replace every CHANGE_ME, set the R2 values

# 3. DNS: app.<domain> and api.<domain> -> the VM (grey cloud first, so Caddy can obtain certificates)
# 4. Database first, then backups, then the release
docker compose -f docker-compose.prod.yml --env-file .env.production build db
docker compose -f docker-compose.prod.yml --env-file .env.production up -d db
deploy/backup/setup.sh         # creates the pgBackRest stanza, verifies WAL archiving, takes the first full backup
deploy/deploy.sh --skip-backup-check   # first release only (nothing to check yet); migrations run here
sudo cp deploy/backup/cron.example /etc/cron.d/yuktiops-backup
deploy/backup/restore-drill.sh # prove the backup restores BEFORE launch (section 6)
```

Verify: `curl -fsS https://api.<domain>/api/health` returns `{"status":"ok"}` and the app loads at
`https://app.<domain>`. Then switch DNS to proxied (orange cloud) as described in section 5.

Do not start the database without the R2 variables set: `archive_command` would fail and WAL would pile up on
the disk (see the runbook entry "WAL archiving failing").

## 4. Server hardening checklist (Hetzner VM)

Tick each item and keep the date.

- [ ] **Hetzner Cloud Firewall** (the primary firewall): inbound TCP 22 from your admin IPs only, TCP 80 and 443
      from anywhere (or from Cloudflare ranges only, see section 5), everything else denied. ICMP allowed.
- [ ] **ufw as a second layer**: `ufw default deny incoming; ufw allow from <admin-ip> to any port 22; ufw allow 80,443/tcp; ufw allow 443/udp; ufw enable`.
      Docker publishes ports by editing iptables directly and **bypasses ufw**, so the Cloud Firewall is what
      protects published ports. The compose file publishes only 80/443 (Caddy); the database has no published port.
- [ ] **SSH keys only**: `/etc/ssh/sshd_config.d/10-yuktiops.conf`:
      `PermitRootLogin no`, `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PubkeyAuthentication yes`,
      `AllowUsers deploy <your-admin-user>`, `MaxAuthTries 3`, `LoginGraceTime 20`; then `sudo sshd -t && sudo systemctl reload ssh`.
      Keep one session open while testing a second login.
- [ ] **fail2ban**: `apt install fail2ban`; `/etc/fail2ban/jail.d/sshd.local` with `[sshd] enabled = true`, `maxretry = 4`,
      `bantime = 1h`, `findtime = 10m`.
- [ ] **unattended-upgrades**: `apt install unattended-upgrades`; `dpkg-reconfigure -plow unattended-upgrades`; set
      `Unattended-Upgrade::Automatic-Reboot "true"; Automatic-Reboot-Time "04:30";` Containers restart by themselves
      (`restart: unless-stopped`; `systemctl enable docker`). Schedule reboots away from the 02:15 backups.
- [ ] **Time sync** (`timedatectl` shows `System clock synchronized: yes`); needed for TLS, WAL and alert timing.
- [ ] **No root-owned secrets lying around**: `.env.production` is `chmod 600`, owned by `deploy`.
- [ ] **Docker daemon**: `/etc/docker/daemon.json` with `{"log-driver":"json-file","log-opts":{"max-size":"20m","max-file":"5"},"live-restore":true,"no-new-privileges":true}`.
- [ ] **Kernel/network sysctls** (`/etc/sysctl.d/99-yuktiops.conf`): `net.ipv4.tcp_syncookies=1`, `net.ipv4.conf.all.rp_filter=1`,
      `net.ipv4.conf.all.accept_redirects=0`, `net.ipv4.icmp_echo_ignore_broadcasts=1`, `vm.swappiness=10`; add a 2 GB swapfile.
- [ ] **Disk alerts**: the YuktiOps agent on this host (section 8) alerts at 80 percent disk. Hetzner volume expansion is online.
- [ ] **Rate limits at the edge**: Cloudflare rules in section 5 plus the application limits (login 30 per 5 minutes per IP,
      registration 10 per hour per IP, agent ingest 30 per minute per server).
- [ ] **Audit the exposed surface** after every change: `ss -tlnp` should show only sshd, and Docker's 80/443; from outside,
      `nmap -Pn <ip>` shows only 22 (admin IPs), 80, 443.
- [ ] **Backups of the VM itself** enabled in the Hetzner console (config safety net; database safety comes from pgBackRest).

## 5. Cloudflare and TLS

1. **Phase A, certificates**: DNS records grey-clouded (DNS only). Caddy gets Let's Encrypt certificates automatically
   (needs ports 80 and 443 open and `ACME_EMAIL` set). Confirm `curl -vI https://app.<domain>`.
2. **Phase B, proxy**: turn on the orange cloud for `app` and `api`; set SSL/TLS mode to **Full (strict)**; enable
   *Always Use HTTPS*, *Min TLS 1.2*, *HTTP/3*. Caddy renews through the proxy (HTTP-01 passes through Cloudflare).
3. **Real client IPs**: in `deploy/Caddyfile` uncomment the `servers` block, list Cloudflare's ranges
   (`https://www.cloudflare.com/ips-v4`, `/ips-v6`) in `trusted_proxies static ...` and keep
   `client_ip_headers CF-Connecting-IP`. Caddy then forwards the true client address in `X-Forwarded-For`; the API
   keeps `TRUST_PROXY=172.29.0.0/24`. Without this step every rate limit would see Cloudflare's addresses.
4. **Authenticated Origin Pulls** (recommended with the proxy on): in Cloudflare enable *SSL/TLS > Origin Server >
   Authenticated Origin Pulls*, download Cloudflare's origin-pull CA, mount it into the `web` container
   (`./deploy/cloudflare-origin-pull-ca.pem:/etc/caddy/cf-ca.pem:ro`) and add to both site blocks:
   ```
   tls {
       client_auth {
           mode require_and_verify
           trust_pool file /etc/caddy/cf-ca.pem
       }
   }
   ```
   Then only Cloudflare can talk to the origin, so `CF-Connecting-IP` cannot be spoofed. Also restrict the Hetzner
   firewall's 80/443 to Cloudflare's ranges. (Alternative: a Cloudflare Origin CA certificate with
   `tls /certs/origin.pem /certs/origin.key` instead of Let's Encrypt.) Test with the grey cloud off only after
   confirming agents still connect (agents are plain HTTPS clients and pass through the proxy).
5. **Cloudflare rules** (WAF > Rate limiting): `/api/auth/*` 20 requests per minute per IP, block; `/v1/register`
   10 per minute per IP, block. Do **not** rate limit `/v1/ingest` below 200 per minute per IP (many servers behind one NAT).
   Enable *Bot Fight Mode*; add a WAF custom rule to challenge non-agent traffic to `/api/auth/register`.
6. **Caching**: leave API paths uncached (default); static assets are fingerprinted and sent `immutable` by Caddy.
7. **R2**: create the private bucket; no public access. Add a lifecycle rule only if you do not rely on
   pgBackRest's own retention (it manages expiry itself; do not add an R2 expiry rule).

## 6. Backups and restore drills

Design: pgBackRest, repository on Cloudflare R2, encrypted client-side (`aes-256-cbc`, key in `.env.production`),
compressed with gzip (the Alpine pgBackRest build has no zstd or lz4). Config is in `deploy/postgres/pgbackrest.conf` (static) plus `PGBACKREST_REPO1_*`
environment variables (secrets) passed by `docker-compose.prod.yml`. Postgres runs with `archive_mode=on` and
`archive_command = pgbackrest ... archive-push`, so every WAL segment (at least once a minute) reaches R2:
**RPO is about one minute**; the base backups make restores fast.

| What | When | Command |
| --- | --- | --- |
| Full backup | Sunday 02:15 | `deploy/backup/backup.sh full` |
| Incremental | Mon to Sat 02:15 | `deploy/backup/backup.sh incr` |
| Health check (age + WAL archiving) | hourly and before every deploy | `deploy/backup/check.sh` |
| Restore drill | monthly (first Saturday) and before launch | `deploy/backup/restore-drill.sh` |

Retention: 4 full, 7 differential; WAL kept for the retained fulls (so point-in-time recovery spans about 4 weeks).
Install the schedule with `deploy/backup/cron.example`. Set `BACKUP_PING_URL` (healthchecks.io check with a 26 hour
period) so a *missing* backup raises an alert.

### Restore drill checklist (do it before launch, then monthly)

1. [ ] `deploy/backup/check.sh` is green (newest backup under 26 hours, WAL archiving OK).
2. [ ] Note the time and run `deploy/backup/restore-drill.sh`. It restores into a throwaway container and volume,
       never touching production and never archiving WAL back (`archive_mode=off`).
3. [ ] Read the script's verification lines: schema present, migrations applied, row counts, newest metric time.
       The newest metric must be within a few minutes of "now" (proves WAL replay, not just the base backup).
4. [ ] Point-in-time test: pick a time 15 minutes ago and run
       `deploy/backup/restore-drill.sh --target-time "2026-11-15 10:30:00+00"`; confirm the newest metric is at or before it.
5. [ ] Record the date, restore duration and RTO below. Alert if the measured RTO exceeds the target (1 hour for the beta).
6. [ ] Confirm the throwaway container and volume are gone (`docker ps -a | grep restore-drill`).
7. [ ] Once per quarter: restore on a *different* machine using only the password manager (cipher pass, R2 token) and
       this repository, to prove nothing lives only on the production VM.
8. [ ] Fix anything that surprised you in `docs/runbook.md` the same day.

Restore drill log (append a row each time):

| Date | Who | Source | Restore time | Ready time | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-15 | Ops agent | local posix repo (throwaway stack, not R2) | 3 s | 5 s (tiny 37 MB database) | PASSED, latest and point-in-time | R2 target untested until credentials exist. Real RTO scales with database size and R2 download speed: repeat on production data |

#### 6.1 Local verification of the backup tooling

The tooling was exercised on the local Docker engine with a posix repository standing in for R2 (the only
difference is `PGBACKREST_REPO1_TYPE`); see the verification log at the end of section 9.

## 7. Releases and rollback

### Tagging

- Every release is a git commit on `main`. The image tag is the short SHA (`deploy.sh` uses `git rev-parse --short=10 HEAD`)
  unless you pass a tag. Mark noteworthy releases with a git tag too: `git tag -a v0.1.0 -m "Free beta launch" && git push --tags`
  and deploy it with `deploy/deploy.sh v0.1.0`.
- Release state lives in `/opt/yuktiops/.deploy/` (`current`, `previous`, `history`,
  `release.env`). `release.env` pins `APP_TAG` so a later plain `docker compose up -d` never jumps to `latest`.
- The last few image tags stay on the VM for fast rollback; older ones are pruned.

### Deploy

```bash
cd /opt/yuktiops && git pull --ff-only
deploy/deploy.sh                 # tag = short SHA of HEAD; refuses a dirty tree
# options: deploy/deploy.sh v0.1.0   |   --pull (use prebuilt registry images)   |   --skip-backup-check (emergency only)
```

Sequence: build images -> `backup/check.sh` and a pre-deploy incremental backup -> **migrations as a separate
one-shot container** (`prisma migrate deploy` on the new image; failure aborts before any running service is touched)
-> restart `api`, `worker`, `web` one at a time, each waiting for healthy -> smoke test against the public URLs
(`HEALTH_URL_API`, `HEALTH_URL_APP`) -> record the release. If any step after the migration fails, the script
**automatically starts the previous tag** and exits non-zero.

Agents ride out the few seconds of API restart: they buffer samples locally for up to 15 minutes.

### Rollback

```bash
deploy/rollback.sh               # back to .deploy/previous
deploy/rollback.sh a1b2c3d4e5    # a specific tag still present on the VM (docker image ls | grep yuktiops)
```

### Migration policy (what makes rollback safe)

Rollback restarts old code on the already-migrated schema, so migrations must be **backward compatible for one
release**: add columns/tables as nullable or defaulted ("expand"); remove or rename only in a *later* release
after no running code uses them ("contract"). Never ship a destructive migration in the same release as the
code change that stops using the column. If a migration corrupts data, do not roll back the code; use
point-in-time recovery (runbook: "Bad migration or data loss").

## 8. Monitoring ourselves

1. **Dogfood the agent.** Create an internal organization ("YuktiOps Ops") in the product, copy its install command and
   run it on the production VM (the Go agent installs as a systemd service). Add monitors and alert rules:
   CPU above 85 percent for 5 minutes, memory above 90 percent, disk above 80 percent, server offline for 3 minutes,
   plus uptime monitors for `https://app.<domain>/` and `https://api.<domain>/api/health` (expect 200 and
   `"status":"ok"`) with a 60 second interval. Alert contacts: your email and one second channel (SMS or push)
   that does not depend on our SMTP relay.
2. **Independent external checks** (UptimeRobot / Better Stack / healthchecks.io), because the product cannot tell
   you it is itself down: HTTPS check of `https://api.<domain>/api/health` (keyword `ok`, 1 minute interval),
   `https://app.<domain>/` (keyword `YuktiOps`), certificate expiry (alert 14 days before), and a domain-expiry
   reminder. Send these alerts to a phone-capable channel.
3. **Dead-man's switches** (healthchecks.io): `BACKUP_PING_URL` (backups, 26 hour grace), and `DEPLOY_NOTIFY_URL`
   (pings on release success, `/fail` on failure).
4. **Logs**: `docker compose -f docker-compose.prod.yml logs -f --tail=200 api worker web db`; Caddy writes JSON access logs;
   Postgres logs slow queries (over 500 ms) and checkpoints.
5. **On-call basics**: keep `docs/runbook.md` open during incidents; after each one add what you learned.

## 9. Load test: 500 agents

Tool: `deploy/loadtest/loadtest.mjs` (Node built-ins only plus the repo's own backend modules for local setup).
It refuses to run against anything but localhost unless `--i-know-this-is-not-production` is passed.

```bash
# local database + API (never production)
docker exec <postgres-container> psql -U <user> -c 'create database yuktiops_ops'
export DATABASE_URL='postgresql://<user>:<password>@localhost:5432/yuktiops_ops?schema=public'
node backend/scripts/prisma.mjs migrate deploy
PORT=4020 node backend/src/server.js &
node deploy/loadtest/loadtest.mjs --agents 500 --duration 300 --interval 30 --out result.json
npm run loadtest -- --agents 500        # same thing through the root script
```

What it does: creates a throwaway account and account API key over HTTP, lifts the free plan's 2-server cap in
the **local** database (`deploy/loadtest/raise-limits.sql` does the same by hand), registers N agents directly in
the database (the public `/v1/register` correctly allows only 60 per hour per IP, see finding 1), then each agent sends
one gzip-compressed JSON batch to `/v1/ingest` every 30 seconds (random start offset spreading the fleet,
plus or minus 5 percent jitter, realistic payload with mounts, interfaces and top processes). It reports
p50/p95/p99 latency per 30-second window and overall, status counts, accepted rows, and database row counts.

### Results (laptop: API, Postgres/Timescale in Docker and the load generator on one machine, dev-mode API, default Prisma pool)

| Run | Agents | Interval | Duration | Requests | Req/s | p50 | p95 | p99 | max | Errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Target load | 500 | 30 s | 330 s | 5,509 | 16.7 | 17 ms | 26 ms | 44 ms | 2.1 s (first request after process start) | 0 (0 percent) |
| Stress: 10x load (about 5,000 agents) | 500 | 3 s | 90 s | 14,981 | 166 | 26 ms | 38 ms | 64 ms | 2.1 s (cold start) | 0 (0 percent) |

Database after the target run: 5,509 `server_metrics` rows for 500 agents (exactly the accepted count), 500 agent
events (one `first_data` per server), 9 connections, 22 MB. Payload: 1,238 bytes JSON, 542 bytes gzip per batch
(about 1.3 GB/month of ingest traffic per 500 agents). Row growth: 500 agents x 2 rows/minute x 60 x 24 is about
1.44 million raw rows per day (Timescale compression and the 8 day raw retention policy keep this small).

**Conclusion: 500 agents are far below the limit.** One API process handled about 10x the target request rate with
sub-70 ms p99 and no errors, so the 4-vCPU VM will not be the first bottleneck; the real ceiling will be
database write amplification (finding 3), not CPU. Re-run on the production-sized VM (from another machine, with
`--api https://<staging> --i-know-this-is-not-production` against a staging stack only) before you advertise a larger fleet.

### Findings (backend; not changed by the Ops agent)

1. **Registration limit blocks fleet rollouts.** `/v1/register` allows 60 per hour per IP and 120 per hour per
   API key (`backend/src/routes/v1.js`). Onboarding 500 servers over HTTP from one office/CI/NAT address takes
   about 8 hours (the loadtest hit 429 at 60 in HTTP mode). Raise the per-key limit (for example 1,000 per hour) and
   keep the per-IP limit modest, or count only failures against the per-IP limit.
2. **In-memory limiter wipes itself.** `Limits.#add` in `backend/src/services/limits.js` calls `windows.clear()` once it
   holds more than 20,000 keys. Each agent creates a new `ingest:<id>:<window>` key every 60 seconds and keys are never
   expired, so 500 agents cause a wipe about every 40 minutes (every 4 minutes at 5,000). A wipe also resets login-failure
   lockouts (`login:fail:*`), so an attacker can flush them by flooding unique keys. Expire old windows (sweep keys whose
   window has passed) instead of clearing everything.
3. **Per-request write amplification.** Every ingest does roughly nine sequential queries and two row UPDATEs
   (`agent` and `monitoredResource`) even when nothing changed, plus `configForAgent`. At 5,000 agents that is about
   333 hot-row updates per second, which will bloat those two tables. Update `lastSeen`/labels at most once per
   minute per agent (or skip when unchanged) and cache the agent/resource lookups for a few seconds.
4. **Cold start.** The first request after a process start takes about 2 seconds (Prisma connection warm-up). Make the
   health check and the first ingest warm the pool at boot (for example a `SELECT 1` before `listen`).
5. **Connection pool.** The compose file sets `connection_limit=20` per process (`DB_POOL_SIZE`); the default
   (cores x 2 + 1) is too small once the worker, alerting queries and ingest all compete. Nothing was starved in the
   test (peak 35 connections at 166 req/s on a loaded laptop).

### Verification log (2026-11-15, local Docker, nothing deployed)

- `docker compose -f docker-compose.prod.yml --env-file .env.production.example config` passes; Caddyfile passes `caddy validate`;
  all scripts pass `shellcheck` (koalaman/shellcheck, `-x`).
- Runtime image builds (171 MB compressed, runs as uid 1000, read-only root FS); `api` becomes healthy, `worker` runs, migrations apply
  from the image with `deploy.sh`'s one-shot command.
- The `web` image build reached the frontend step and failed only because `frontend/src/pages/settings/index.jsx` imports a
  missing `./Account` (the frontend was mid-rewrite). Re-run `docker build --target web .` once the frontend builds.
- pgBackRest on the production db image: stanza create, WAL archiving check, full and incremental backups, `check.sh`, and
  `restore-drill.sh` (latest and `--target-time`) all passed against a local posix repository (5,001 rows restored including a row
  that existed only in WAL; the point-in-time run restored 5,000). Problems found and fixed while testing: the Alpine pgBackRest
  has no zstd/lz4 (compression is gzip), the superuser is `POSTGRES_USER` not `postgres`, restored instances need
  `max_connections` at least equal to the primary's, and S3 env vars must not be empty when the repo type is `s3`.
- `deploy.sh` (backup check, pre-deploy backup, migrations, rolling restart, smoke test), automatic rollback of a release whose
  API crashes (previous tag restarted, exit code 1), and `rollback.sh` were each run end to end on a throwaway compose project
  (Caddy replaced by a stub image because the frontend build was broken).

## 10. Launch checklist

- [ ] Section 1 items provided; `.env.production` filled (no `CHANGE_ME` left: `grep CHANGE_ME .env.production` is empty).
- [ ] Section 4 hardening done; Hetzner firewall verified from outside.
- [ ] DNS, TLS (Full strict) and Cloudflare rules in place; `curl -I https://app.<domain>` shows the security headers.
- [ ] First deploy succeeded; `https://api.<domain>/api/health` is ok.
- [ ] Backups: stanza created, first full backup taken, cron installed, **restore drill passed and logged**.
- [ ] Monitoring: agent installed on the VM, alert rules and contacts tested (stop the worker, confirm a page arrives), external checks live.
- [ ] Rollback rehearsed once (`deploy/rollback.sh`, then deploy again).
- [ ] Load test re-run against staging if the fleet size target changed; backend findings in section 9 triaged.
- [ ] Runbook read by everyone who is on call.
