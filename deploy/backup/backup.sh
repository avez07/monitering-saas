#!/usr/bin/env bash
# Take a pgBackRest backup. Schedule (see cron.example): full weekly, incremental daily.
#   deploy/backup/backup.sh full|diff|incr
# Continuous WAL archiving (point-in-time recovery) is separate and runs inside Postgres.
set -euo pipefail
# shellcheck source=../common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../common.sh"
need docker
type=${1:-incr}
case "$type" in
  full | diff | incr) ;;
  *) die "usage: $0 full|diff|incr" ;;
esac

log "pgBackRest $type backup starting"
ping=$(env_value BACKUP_PING_URL)
if [ -n "$ping" ]; then ping_url "$ping/start"; fi
if pgbr --type="$type" backup; then
  log "backup finished"
  # Dead man's switch: BACKUP_PING_URL should alert us if it is NOT called for 26 hours.
  ping_url "$ping"
else
  if [ -n "$ping" ]; then ping_url "$ping/fail"; fi
  die "backup FAILED"
fi
pgbr info
