#!/usr/bin/env bash
# One-time (idempotent) pgBackRest setup after the db container is up with R2 credentials configured:
# creates the stanza, verifies WAL archiving works end to end, takes the first full backup.
set -euo pipefail
# shellcheck source=../common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../common.sh"
need docker
log "creating stanza $STANZA"
pgbr stanza-create
log "checking archive_command and repository access (switches a WAL segment)"
pgbr check
log "taking initial full backup"
pgbr --type=full backup
pgbr info
log "setup complete. Now install deploy/backup/cron.example and run the restore drill."
