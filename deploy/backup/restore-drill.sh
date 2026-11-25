#!/usr/bin/env bash
# Restore the latest backup (or a point in time) into a THROWAWAY container and verify it. Never touches
# the production data volume and never archives WAL into the production repository.
#   deploy/backup/restore-drill.sh [--target-time "2026-11-15 10:30:00+00"] [--keep]
# Reports the restore duration, which is the measured RTO for the runbook.
set -euo pipefail
# shellcheck source=../common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../common.sh"
need docker
target=""
keep=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target-time)
      target=$2
      shift 2
      ;;
    --keep)
      keep=1
      shift
      ;;
    *) die "unknown option: $1" ;;
  esac
done

image=${DRILL_IMAGE:-$(dc config --images | grep -E 'yuktiops-db' | head -n1)}
[ -n "$image" ] || die "could not determine the db image (run: docker compose build db)"
name=yuktiops-restore-drill
volume=yuktiops-restore-drill-data
envfile=$(mktemp)
chmod 600 "$envfile"
cleanup() {
  rm -f "$envfile"
  if [ "$keep" = 0 ]; then
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker volume rm "$volume" >/dev/null 2>&1 || true
  else
    log "kept container $name and volume $volume (remove them by hand)"
  fi
}
trap cleanup EXIT
docker rm -f "$name" >/dev/null 2>&1 || true
docker volume rm "$volume" >/dev/null 2>&1 || true
docker volume create "$volume" >/dev/null

# Same repository settings as production, read from the env file (used read-only).
repo_type=$(env_value BACKUP_REPO_TYPE)
{
  echo "PGBACKREST_REPO1_TYPE=${repo_type:-s3}"
  if [ "${repo_type:-s3}" = s3 ]; then
    echo "PGBACKREST_REPO1_S3_ENDPOINT=$(env_value R2_ENDPOINT)"
    echo "PGBACKREST_REPO1_S3_BUCKET=$(env_value R2_BUCKET)"
    echo "PGBACKREST_REPO1_S3_REGION=auto"
    echo "PGBACKREST_REPO1_S3_KEY=$(env_value R2_ACCESS_KEY_ID)"
    echo "PGBACKREST_REPO1_S3_KEY_SECRET=$(env_value R2_SECRET_ACCESS_KEY)"
  fi
  echo "PGBACKREST_REPO1_CIPHER_PASS=$(env_value PGBACKREST_CIPHER_PASS)"
} >"$envfile"
# DRILL_DOCKER_ARGS lets tests mount a local posix repository, e.g. "-v repo:/repo -e PGBACKREST_REPO1_PATH=/repo".
# shellcheck disable=SC2206
extra=(${DRILL_DOCKER_ARGS:-})
# Disk repository: mount the backup directory read-only so the drill can never change production backups.
if [ "${repo_type:-s3}" = posix ]; then
  backup_dir=$(env_value BACKUP_DIR)
  [ -n "$backup_dir" ] || die "BACKUP_DIR is not set in $ENV_FILE"
  extra+=(-v "$backup_dir:/yuktiops:ro")
fi

if [ -n "$target" ]; then
  restore_args=(--stanza="$STANZA" --delta --type=time "--target=$target" --target-action=promote restore)
else
  restore_args=(--stanza="$STANZA" --delta restore)
fi

start=$(date +%s)
log "restoring into volume $volume (${target:+PITR to $target; }latest backup + archived WAL)"
docker run --rm --user postgres --env-file "$envfile" "${extra[@]}" \
  -v "$volume:/var/lib/postgresql/data" --entrypoint pgbackrest "$image" "${restore_args[@]}"
restored=$(date +%s)
log "restore finished in $((restored - start))s; starting Postgres for recovery"

# max_connections must be >= the primary's (100) or recovery refuses to start.
# archive_mode=off: the drill must never push WAL into the production repository.
docker run -d --name "$name" --user postgres --env-file "$envfile" "${extra[@]}" \
  -v "$volume:/var/lib/postgresql/data" --entrypoint postgres "$image" \
  -c archive_mode=off -c listen_addresses=localhost -c max_connections=100 -c shared_buffers=128MB >/dev/null

user=$(env_value POSTGRES_USER)
db=$(env_value POSTGRES_DB)
for _ in $(seq 1 120); do
  [ "$(docker inspect -f '{{.State.Running}}' "$name")" = true ] || break
  docker exec "$name" pg_isready -q -U "$user" -d "$db" && break
  sleep 2
done
docker exec "$name" pg_isready -U "$user" -d "$db" || {
  docker logs --tail 50 "$name" >&2
  die "restored database did not come up"
}
# Wait until WAL replay has finished.
for _ in $(seq 1 120); do
  [ "$(docker exec "$name" psql -U "$user" -d "$db" -Atc 'select pg_is_in_recovery()')" = f ] && break
  sleep 2
done
ready=$(date +%s)
sql() { docker exec "$name" psql -U "$user" -d "$db" -Atc "$1"; }

log "verifying restored data"
fail=0
check() { # check <label> <sql> <minimum>
  local value
  value=$(sql "$2" || echo -1)
  if [ "$value" -ge "$3" ] 2>/dev/null; then
    log "OK   $1 = $value"
  else
    log "FAIL $1 = $value (expected >= $3)"
    fail=1
  fi
}
check "tables in public schema" "select count(*) from information_schema.tables where table_schema='public'" 5
check "migrations applied" 'select count(*) from _prisma_migrations where finished_at is not null' 1
check "organizations" 'select count(*) from "Organization"' 0
check "servers" 'select count(*) from "Agent"' 0
check "metric rows (server_metrics)" 'select count(*) from server_metrics' 0
# shellcheck disable=SC2016  # $$ is Postgres dollar quoting, not a shell variable
log "newest metric time in the restored copy: $(sql 'select coalesce(max(time)::text, $$none$$) from server_metrics')"
log "timescaledb extension: $(sql "select extversion from pg_extension where extname='timescaledb'")"
log "TOTAL: restore took $((restored - start))s, database ready after $((ready - start))s (this is your measured RTO)"
[ "$fail" = 0 ] || die "drill FAILED"
log "drill PASSED. Record the date and timings in docs/ops.md (restore drill log)."
