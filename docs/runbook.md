# YuktiOps runbook

Run these on the VM as the `deploy` user in `/opt/yuktiops`. Shorthand used below:

```bash
alias dcp='docker compose -f docker-compose.prod.yml --env-file .env.production --env-file .deploy/release.env'
```

(`release.env` exists after the first deploy.) General first steps for any incident:

1. Is it us or the world? Check the external uptime checks and `https://api.<domain>/api/health` from your phone.
2. `dcp ps` (state and health), `dcp logs --tail=200 api worker web db`, `df -h`, `free -m`, `uptime`.
3. Decide: restart a service, roll back (`deploy/rollback.sh`), or restore. Write down what you do and when.

## Quick reference

| Task | Command |
| --- | --- |
| Status | `dcp ps` |
| Logs | `dcp logs -f --tail=200 api` (also `worker-ingest`, `worker-checks`, `worker-alerts`, `worker-notify`, `worker-housekeeping`, `redis`, `pgbouncer`, `web`, `db`) |
| Restart one service | `dcp restart api` |
| psql shell | `dcp exec db psql -U "$(grep ^POSTGRES_USER .env.production \| cut -d= -f2)" yuktiops` |
| Roll back | `deploy/rollback.sh` |
| Backup status | `deploy/backup/check.sh` and `dcp exec -u postgres db pgbackrest --stanza=yuktiops info` |
| Restore drill | `deploy/backup/restore-drill.sh` |
| Caddy config reload | `dcp exec web caddy reload --config /etc/caddy/Caddyfile` |

## Full outage (site down, API unreachable)

1. `dcp ps`. If `db` is not healthy go to "Database down or not accepting connections". If `web` is down:
   `dcp logs --tail=100 web` (bad Caddyfile or certificate trouble, see "Certificate problems").
2. `curl -sS http://127.0.0.1` from the VM does not reach the API directly (no published port); test through the network:
   `dcp exec api node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>r.text()).then(console.log)"`.
3. If the last deploy is the cause, `deploy/rollback.sh`.
4. If Docker itself is down: `sudo systemctl status docker`; `sudo systemctl restart docker` (containers restart themselves).
5. If the VM is unreachable: Hetzner console, reboot; if the disk is lost, rebuild the VM (section 3 of `docs/ops.md`) and
   restore the database from R2 (below).

## Database full (disk or volume)

Symptoms: `df -h` shows the Docker volume above 90 percent, Postgres logs `No space left on device`, API 503 on `/api/health`.

1. Find the culprit: `docker system df -v | head -30`; in psql
   `select hypertable_name, pg_size_pretty(hypertable_size(format('%I',hypertable_name)::regclass)) from timescaledb_information.hypertables;`
   and `select pg_size_pretty(pg_database_size(current_database()));`.
2. **WAL pile-up** is the most common cause: `dcp exec db sh -c 'du -sh /var/lib/postgresql/data/pg_wal; ls /var/lib/postgresql/data/pg_wal/archive_status | grep -c ready'`.
   If many `.ready` files exist, archiving to R2 is failing, see "WAL archiving failing". Do not delete WAL by hand.
3. Free safe space first: `docker image prune -af --filter "until=168h"` (keeps current and rollback images in use), `docker builder prune -af`,
   `sudo journalctl --vacuum-size=200M`.
4. Raw metrics: confirm the retention and compression policies run
   (`select * from timescaledb_information.jobs;`). Force old chunks out: `select drop_chunks('server_metrics', older_than => interval '8 days');`
   (raw data older than 8 days is only kept as rollups, see PLAN.md).
5. Grow the disk: Hetzner console, resize the volume/server disk (online), then `sudo resize2fs <device>`.
6. If Postgres stopped on a full disk: free space (step 3), `dcp up -d db`, check `dcp logs db` for recovery completing.
7. After resolving, alert thresholds: disk 80 percent warning, 90 percent critical (agent alert rules).

## Database down or not accepting connections

1. `dcp logs --tail=100 db`. Crash recovery after a restart may take a minute; `pg_isready` in the health check reports when it is up.
2. Out of connections (`too many clients`): `select count(*), state from pg_stat_activity group by state;` Restart the worker/API
   (`dcp restart worker api`) and check `DB_POOL_SIZE` (20 per process, `max_connections=100`).
3. Corrupt data directory or lost volume: restore (below). Do not "fix" files by hand.

## Restore the database from backup (disaster or bad migration/data loss)

1. Stop writers: `dcp stop api worker`. Keep `web` up so users see a 502 page rather than timeouts (or stop it too).
2. Decide the target: latest (default) or a point in time just before the damage.
3. Take a safety copy of the broken volume if there is space: `docker run --rm -v yuktiops_db-data:/d -v /root/safety:/o alpine tar czf /o/db-data.tgz -C /d .`
4. Restore into the live volume (the container must be stopped):
   ```bash
   dcp stop db
   dcp run --rm --no-deps --user postgres --entrypoint pgbackrest db --stanza=yuktiops --delta --target-action=promote restore
   # point in time instead:
   # dcp run --rm --no-deps --user postgres --entrypoint pgbackrest db --stanza=yuktiops --delta --type=time --target="2026-11-15 10:30:00+00" --target-action=promote restore
   dcp up -d db
   ```
5. Wait for recovery (`dcp logs -f db` shows "database system is ready to accept connections"), then check data:
   `select max(time) from server_metrics;` and row counts.
6. After a point-in-time restore Postgres starts a new timeline: run `deploy/backup/backup.sh full` right away so a clean full backup exists on the new timeline.
7. `dcp up -d api worker`; run `deploy/backup/check.sh`. Agents resend buffered samples (up to 15 minutes) automatically.
8. Write the post-mortem; add the measured time to the drill log in `docs/ops.md`.

## Bad migration or data loss

1. Do not roll the code back if the migration changed or dropped data. Stop writers (`dcp stop api worker`).
2. If the migration failed midway: `dcp run --rm --no-deps -e HOME=/tmp api node backend/scripts/prisma.mjs migrate status`. Fix forward
   with a new migration, or mark the failed one resolved (`migrate resolve --rolled-back <name>`) after repairing the schema by hand.
3. If data was damaged, use point-in-time recovery to just before the migration started (the deploy log and the pre-deploy
   incremental backup give the time) into a *scratch* instance first (`deploy/backup/restore-drill.sh --target-time ...`),
   export the affected tables from the scratch copy, and import them into production, or restore production as above if the whole database is affected.

## Worker stuck (alerts and uptime checks not firing)

Symptoms: no new `lastCheckedAt` on website monitors, no alert emails, `worker` logs silent.

1. `dcp ps` and `dcp logs --tail=100 worker-checks worker-alerts worker-notify worker-housekeeping worker-ingest`. Workers run by role (`node src/worker.js --role=ingest|checks|alerts|notify|housekeeping|all`), one compose service each, with a healthcheck on `/healthz`
   on BullMQ queues in Redis; any number can run and each scheduled job runs once. `curl localhost:9100/healthz` (all) or
   9101-9105 (checks, alerts, notify, housekeeping, ingest; inside the container: `dcp exec worker-checks node -e "fetch('http://127.0.0.1:9101/healthz').then(r=>r.text()).then(console.log)"`) shows the Redis connection, queue counts and the last processed time.
2. Crash loop: read the stack trace (often the database, Redis or SMTP). `dcp restart worker-<role>`.
3. Running but doing nothing: check Redis is up (`redis-cli ping`) and that `/healthz` reports queue counts. Waiting jobs that
   never drain mean no worker serves that role; start one. Failed notification jobs (5 attempts used) are the dead letters:
   their outbox rows have status `failed`.
4. Long-running job (slow query): in psql `select pid, now()-query_start as age, state, left(query,100) from pg_stat_activity where datname=current_database() order by age desc limit 10;`
   and `select pg_cancel_backend(<pid>);` for a runaway query.
5. Email stuck: check `SMTP_HOST` credentials (`dcp logs worker | grep -i smtp`); test from the relay's dashboard. Rotate
   `SMTP_PASSWORD` in `.env.production` and `dcp up -d worker-notify`.
6. Confirm recovery: a test alert fires within two intervals (`WORKER_INTERVAL_MS`, default 30 s).

## High ingest lag / agents showing offline

Symptoms: servers flip to "offline", charts have gaps, `/v1/ingest` latency or 429/5xx in Caddy logs.

1. Is the API healthy? `dcp logs --tail=200 api`; `dcp stats --no-stream` (CPU/memory against the limits).
2. Caddy view of errors: `dcp logs web | grep -E '"status":(429|5[0-9][0-9])' | tail`. Many 429 means rate limits: check
   `TRUST_PROXY` (every client looking like one IP is the classic cause; compare the `remote_ip`/`X-Forwarded-For` in logs to real clients).
3. Database slow: `select now()-query_start age, left(query,120) from pg_stat_activity where state='active' order by age desc limit 10;`;
   check locks `select * from pg_locks where not granted;` and IO (`iostat -x 2 5`). The ingest path updates the `Agent` and `MonitoredResource` rows on every
   request; autovacuum lag on those tables shows up as rising latency (`select relname, n_dead_tup from pg_stat_user_tables order by n_dead_tup desc limit 5;`,
   then `VACUUM (ANALYZE) "Agent"; VACUUM (ANALYZE) "MonitoredResource";`).
4. Pool exhaustion: Prisma "Timed out fetching a new connection" in logs. Raise `DB_POOL_SIZE` (and keep `max_connections` above 2 x pool + 15), `dcp up -d api worker-ingest worker-checks worker-alerts worker-notify worker-housekeeping`. Connections now go through PgBouncer (see "PgBouncer problems" below).
5. Memory pressure/OOM: `dmesg -T | grep -i oom`, `docker inspect -f '{{.State.OOMKilled}}' $(dcp ps -q api)`. Raise the limit in `docker-compose.prod.yml`.
6. A single noisy agent (huge batches): API enforces 120 samples per batch and 512 KB per body; check the Caddy log for one source and revoke its credential in the UI.
7. Agents buffer up to 15 minutes and backfill, so a short outage loses nothing; after a long outage expect a gap older than 30 minutes (rejected as stale).
8. Run `node deploy/loadtest/loadtest.mjs` against a staging copy to compare numbers with `docs/ops.md` section 9 after changes.

## Queue backlog (ingest lag, late alerts or notifications)

Symptoms: `yuktiops_ingest_lag_seconds` or `yuktiops_queue_lag_seconds{queue=...}` rising, agents answered `503` (backpressure: more
than 50,000 jobs waiting or the oldest older than 60 s), charts behind real time, uptime checks or notifications late.

1. Measure: `dcp exec api node -e "fetch('http://127.0.0.1:4000/metrics',{headers:{Authorization:'Bearer '+process.env.METRICS_TOKEN}}).then(r=>r.text()).then(console.log)"`
   (or Bull Board if enabled). Look at `yuktiops_queue_jobs{queue,state}` for the growing queue: `waiting` growing with `active` at its
   limit means too little worker capacity; `waiting` growing with `active` 0 means no worker serves that queue; `failed` growing means jobs error.
2. Is the role running and healthy? `dcp ps | grep worker`; `dcp logs --tail=100 worker-<role>`. Queue to role: `ingest`, `side-effects`, `lastseen`
   -> worker-ingest; `checks` -> worker-checks; `alerts` -> worker-alerts; `notify` -> worker-notify; `housekeeping` -> worker-housekeeping.
3. Capacity: `dcp up -d --scale worker-<role>=3 worker-<role>` (safe: every job runs once). Ingest lag with a healthy worker usually
   means Postgres is slow (see "High ingest lag" step 3) or PgBouncer is saturated (below); check `dcp logs pgbouncer` first.
4. Failures: `failed` jobs are kept (last 1,000 for ingest, 50 for housekeeping). Read the reason in Bull Board or
   `redis-cli` (`ZRANGE yk:bull:ingest:failed 0 5`; BullMQ stores the reason on the job hash). Fix the cause, then retry from Bull Board. Failed notification jobs
   (5 attempts) leave the outbox row with status `failed`; the stuck-delivery sweep re-queues rows still `pending`.
5. Do **not** flush Redis to "clear" a backlog: ingest jobs in it are the only copy of those samples until a worker writes them.
   If the backlog is junk (a test run), clear only that queue from Bull Board ("Clean"), never the whole Redis.
6. Back to normal: lag under 10 s and `waiting` near 0; agents recover by themselves (they buffer and retry on 503 with Retry-After).

## Redis down

Symptoms: API answers `503` on `/v1/ingest` and login/limits errors, workers log `redis(...)` connection errors, `/healthz` of
workers reports `redis:false`, `dcp ps` shows redis unhealthy.

1. `dcp ps redis`, `dcp logs --tail=100 redis`. Typical causes: out of memory (`noeviction` with `maxmemory` reached; check `docker stats`, `redis-cli info memory`),
   disk full (AOF), the container was OOM-killed or killed by a host restart.
2. Restart: `dcp restart redis`. It reloads the AOF (and loses at most about 1 s of queue writes). Services reconnect on their own;
   confirm with `dcp exec redis sh -c 'REDISCLI_AUTH=$REDIS_PASSWORD redis-cli ping'` and the workers' `/healthz`.
3. Memory pressure: look for a runaway queue (`redis-cli --scan --pattern 'yk:bull:*:wait' | head`, `LLEN` on it); fix the backlog (runbook above) rather than raising limits.
   If Redis is simply too small, raise `memory` for `redis` in `docker-compose.prod.yml` and `dcp up -d redis`.
4. Corrupt AOF after a hard crash: `dcp run --rm --no-deps redis redis-check-aof --fix /data/appendonlydir/<file>.incr.aof` (check the
   exact file name with `ls`), then start Redis. Last resort: restore the newest RDB from R2 (`docs/ops.md` 6.2).
5. What you lose if Redis is gone entirely: jobs queued at that instant (agents re-send buffered samples; sessions are in Postgres), rate limit counters and
   lockouts reset, the agent cache rebuilds from Postgres. Recurring schedulers are re-created when workers start.
6. After recovery, check the ingest `waiting` count drains and that agents marked offline return within a minute.

## PgBouncer problems

Symptoms: Prisma errors `Timed out fetching a new connection`, `Can't reach database server at pgbouncer:6432`, `prepared statement ... does not exist`, or
queue lag with a healthy Postgres.

1. `dcp ps pgbouncer`, `dcp logs --tail=100 pgbouncer`. Show pools: `dcp exec pgbouncer sh -c 'psql -h 127.0.0.1 -p 6432 -U "$DB_USER" pgbouncer -c "SHOW POOLS;"'`
   (needs the admin console enabled; if not, read `cl_waiting` through the logs). `cl_waiting > 0` for long means the pool is too small or queries are slow.
2. Pool too small: raise `PGBOUNCER_POOL_SIZE` (default 40; keep it below Postgres `max_connections` minus 20) in `.env.production` and `dcp up -d pgbouncer`.
   Too many clients: lower `DB_POOL_SIZE` or the replica count (`replicas x DB_POOL_SIZE` must stay under `MAX_CLIENT_CONN`, 600).
3. `prepared statement` errors: a service is using a URL without `pgbouncer=true`. All app URLs in `docker-compose.prod.yml` carry it; migrations use `DIRECT_DATABASE_URL` and must never go through the pooler.
4. Authentication failed: the pooler reads `POSTGRES_USER`/`POSTGRES_PASSWORD` at start; after a password change run `dcp up -d pgbouncer` and restart the app services.
5. Bypass in an emergency (pooler broken, Postgres fine): set `DATABASE_URL` for the services to the `DIRECT_DATABASE_URL` value in `docker-compose.prod.yml`
   (port 5432, no `pgbouncer=true`), lower `DB_POOL_SIZE` to 8, `dcp up -d api worker-*`. Revert when fixed.

## Certificate problems

Symptoms: browsers or agents report TLS errors; Caddy logs `obtaining certificate` failures; cert expiry alert fires.

1. `dcp logs web | grep -iE 'tls|acme|certificate' | tail -30`.
2. Common causes: port 80/443 blocked (Hetzner firewall), DNS not pointing at the VM, Cloudflare in *Flexible* SSL mode (must be *Full (strict)*),
   Let's Encrypt rate limit (5 duplicate certs per week; wait, do not wipe `caddy-data`), authenticated origin pulls misconfigured
   (requests rejected before reaching Caddy handlers).
3. Check what is served: `openssl s_client -connect <ip>:443 -servername app.<domain> </dev/null 2>/dev/null | openssl x509 -noout -dates -issuer`.
4. Force a retry: `dcp restart web` (certificates and account keys persist in the `caddy-data` volume; never delete it casually).
5. Emergency: switch the DNS record to DNS-only (grey) so Let's Encrypt can validate directly, or install a Cloudflare Origin CA certificate
   (`tls /certs/origin.pem /certs/origin.key`) and reload Caddy.
6. Agents refuse plain HTTP and verify TLS: a broken certificate on `api.<domain>` stops all ingestion; fix it first.

## WAL archiving failing / backups failing

Symptoms: `deploy/backup/check.sh` fails, healthchecks.io says backups are late, `pg_wal` grows, Postgres logs `archive command failed`.

1. `dcp exec -u postgres db pgbackrest --stanza=yuktiops check` and `dcp logs db | grep -i archive | tail`;
   pgBackRest logs: `dcp exec db sh -c 'tail -50 /var/log/pgbackrest/*.log'`.
2. Typical causes: expired or rotated R2 token (update `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`, then `dcp up -d db`, which restarts Postgres briefly),
   wrong endpoint/bucket, clock skew, R2 outage (archiving retries automatically; WAL accumulates meanwhile, so watch the disk),
   wrong `PGBACKREST_CIPHER_PASS` (never change it on an existing repository; a new passphrase needs a new stanza/bucket path).
3. After fixing, WAL drains by itself; confirm `archive_status` `.ready` count falls to zero and take a full backup: `deploy/backup/backup.sh full`.
4. If the stanza is broken after a restore or timeline change: `pgbackrest --stanza=yuktiops stanza-upgrade`, then a full backup.

## Bad release / failed deploy

`deploy/deploy.sh` rolls back automatically when a service is unhealthy or the smoke test fails. Otherwise:
`deploy/rollback.sh`, then investigate with `dcp logs`. See the migration policy in `docs/ops.md` section 7 before rolling back across a migration.

## Security incidents

Suspected credential leak: rotate the secret in `.env.production` (`BILLING_WEBHOOK_SECRET`, `SMTP_PASSWORD`, R2 token), `dcp up -d api worker-ingest worker-checks worker-alerts worker-notify worker-housekeeping`. Connections now go through PgBouncer (see "PgBouncer problems" below).
Account API key or agent credential leaked: revoke in the product (Settings > API key, or disconnect the server). A leaked `POSTGRES_PASSWORD`
needs `ALTER USER` in psql plus the env change and a restart of `api` and `worker`. Check `/var/log/auth.log`, `fail2ban-client status sshd`, and Caddy logs for the source.
