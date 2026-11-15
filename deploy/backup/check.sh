#!/usr/bin/env bash
# Backup health gate. Exits non-zero when the newest backup is older than the limit (default 26 hours)
# or WAL archiving is broken. Used by deploy.sh before migrations and by the hourly cron.
#   deploy/backup/check.sh [max-age-hours]
set -euo pipefail
# shellcheck source=../common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../common.sh"
need docker
need jq
max_hours=${1:-${MAX_AGE_HOURS:-26}}
info=$(pgbr info --output=json) || die "pgbackrest info failed"
last=$(printf '%s' "$info" | jq -r '[.[0].backup[]?.timestamp.stop] | max // empty')
[ -n "$last" ] || die "no backup exists yet. Run deploy/backup/setup.sh"
age_hours=$((($(date +%s) - last) / 3600))
log "newest backup finished ${age_hours}h ago (limit ${max_hours}h)"
[ "$age_hours" -le "$max_hours" ] || die "newest backup is too old"
pgbr check || die "WAL archiving check failed (see docs/runbook.md: WAL archiving)"
log "backups healthy"
