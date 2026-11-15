#!/usr/bin/env bash
# Release YuktiOps on the production VM.
#   deploy/deploy.sh [tag] [--skip-backup-check] [--pull | --no-build]
#
# Steps: build (or pull) images tagged <tag> -> backup precheck + pre-deploy backup -> database
# migrations as their own step -> rolling restart (api, worker, web) with health gates -> public smoke
# test. If anything after the migration step fails, the previous release is started again automatically.
# The default tag is the short git SHA of the checked-out commit. See docs/ops.md "Releases and rollback".
set -euo pipefail
# shellcheck source=common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
need docker
need curl
need jq

tag=""
skip_backup=0
pull=0
no_build=0
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-backup-check)
      skip_backup=1
      shift
      ;;
    --pull)
      pull=1
      shift
      ;;
    --no-build)
      no_build=1 # images with this tag already exist on the host (CI-built and loaded)
      shift
      ;;
    -*) die "unknown option: $1" ;;
    *)
      tag=$1
      shift
      ;;
  esac
done
[ -f "$ENV_FILE" ] || die "$ENV_FILE not found (copy .env.production.example and fill it in)"
if [ -z "$tag" ]; then
  need git
  tag=$(git -C "$ROOT" rev-parse --short=10 HEAD)
  [ -z "$(git -C "$ROOT" status --porcelain)" ] || die "working tree is dirty; commit or pass an explicit tag"
fi
[[ "$tag" =~ ^[A-Za-z0-9_.-]+$ ]] || die "invalid tag: $tag"
previous=""
[ -f "$STATE_DIR/current" ] && previous=$(cat "$STATE_DIR/current")
log "deploying tag $tag (currently running: ${previous:-none})"
ping_notify() { ping_url "$(env_value DEPLOY_NOTIFY_URL)$1"; }

# 1. Images ----------------------------------------------------------------------------------------
export APP_TAG=$tag
if [ "$pull" = 1 ]; then
  dc pull api web
elif [ "$no_build" = 1 ]; then
  log "using existing images for tag $tag"
else
  dc build api web db
fi

# 2. Backup precheck: never migrate without a restorable backup ---------------------------------------
if [ "$skip_backup" = 1 ]; then
  log "WARNING: backup precheck skipped"
else
  dc up -d db
  wait_healthy db 120 || die "database is not healthy"
  "$ROOT/deploy/backup/check.sh" || die "backup precheck failed. Fix backups first (docs/runbook.md) or pass --skip-backup-check at your own risk"
  log "taking pre-deploy incremental backup"
  "$ROOT/deploy/backup/backup.sh" incr
fi

# 3. Migrations: a separate one-shot container on the NEW image ---------------------------------------
# Migrations must be backward compatible with the previous release (expand, then contract in a later
# release), because a rollback restarts the old code on the migrated schema.
dc up -d db
wait_healthy db 120 || die "database is not healthy"
log "running migrations"
if ! dc run --rm --no-deps -T -e HOME=/tmp api node backend/scripts/prisma.mjs migrate deploy; then
  ping_notify /fail
  die "migration FAILED. The running release was not touched. Inspect with: docker compose logs, then see docs/runbook.md (failed migration)"
fi

# 4. Rolling restart with health gates, automatic rollback ---------------------------------------------
rollback() {
  log "RELEASE FAILED: $1"
  if [ -n "$previous" ]; then
    log "rolling back to $previous"
    if roll_to "$previous"; then
      record_release "$previous"
      ping_notify /fail
      die "rolled back to $previous. Schema stays migrated (see docs/ops.md: rollback and migrations)"
    fi
    ping_notify /fail
    die "ROLLBACK ALSO FAILED. Follow docs/runbook.md: full outage"
  fi
  ping_notify /fail
  die "no previous release to roll back to"
}
roll_to "$tag" || rollback "a service did not become healthy on $tag"
smoke_test || rollback "public smoke test failed"

record_release "$tag"
ping_notify ""
log "release $tag is live"
dc ps

# Keep the last five app images for fast rollbacks; remove older ones.
mapfile -t old < <(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E '^yuktiops-(app|web):' | sort -u | grep -v ":$tag$" | grep -v ":${previous:-none}$" | tail -n +9 || true)
if [ "${#old[@]}" -gt 0 ]; then docker image rm "${old[@]}" >/dev/null 2>&1 || true; fi
