#!/usr/bin/env bash
# Redis RDB snapshot -> Cloudflare R2 (S3 API). Run from /opt/yuktiops (cron: see cron.example).
#
#   deploy/backup/redis-snapshot.sh
#
# Redis already persists with AOF (everysec) and periodic RDB inside the redis-data volume; this copies a
# fresh point-in-time dump.rdb off the VM. What is in Redis is rebuildable (queues of work in flight, rate
# limit counters, caches), so this is for a faster recovery of in-flight jobs, not the system of record
# (Postgres is). Needs the AWS CLI on the host (`aws`), and R2_* from .env.production.
# Not exercised against real R2 in this repository (no credentials); the BGSAVE/copy half was run locally.
set -euo pipefail
# shellcheck source=../common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../common.sh"
need aws

pass=$(env_value REDIS_PASSWORD)
endpoint=$(env_value R2_ENDPOINT)
bucket=$(env_value R2_BUCKET)
[ -n "$pass" ] && [ -n "$endpoint" ] && [ -n "$bucket" ] || die "REDIS_PASSWORD, R2_ENDPOINT and R2_BUCKET must be set in $ENV_FILE"

rcli() { dc exec -T -e REDISCLI_AUTH="$pass" redis redis-cli "$@"; }
before=$(rcli lastsave | tr -d '\r')
rcli bgsave >/dev/null
for _ in $(seq 1 60); do
  now=$(rcli lastsave | tr -d '\r')
  [ "$now" != "$before" ] && break
  sleep 1
done
[ "${now:-$before}" != "$before" ] || die "BGSAVE did not finish within 60 s"

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
dc cp redis:/data/dump.rdb "$out/dump.rdb"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
AWS_ACCESS_KEY_ID=$(env_value R2_ACCESS_KEY_ID) AWS_SECRET_ACCESS_KEY=$(env_value R2_SECRET_ACCESS_KEY) \
  aws s3 cp "$out/dump.rdb" "s3://$bucket/redis/dump-$stamp.rdb" --endpoint-url "https://$endpoint" --region auto --only-show-errors
log "redis snapshot uploaded: redis/dump-$stamp.rdb"
ping_url "$(env_value REDIS_BACKUP_PING_URL)"
