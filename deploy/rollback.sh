#!/usr/bin/env bash
# Roll back to the previous release (or a named tag) without rebuilding.
#   deploy/rollback.sh [tag]
# Database schema is NOT reverted: migrations are written backward compatible for one release. If a
# migration damaged data, use point-in-time recovery instead (docs/runbook.md: bad migration / data loss).
set -euo pipefail
# shellcheck source=common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
need docker
need curl
tag=${1:-}
if [ -z "$tag" ]; then
  [ -f "$STATE_DIR/previous" ] || die "no previous release recorded; pass a tag (see $STATE_DIR/history)"
  tag=$(cat "$STATE_DIR/previous")
fi
[[ "$tag" =~ ^[A-Za-z0-9_.-]+$ ]] || die "invalid tag: $tag"
current=""
[ -f "$STATE_DIR/current" ] && current=$(cat "$STATE_DIR/current")
for image in yuktiops-app yuktiops-web; do
  docker image inspect "${APP_IMAGE_PREFIX:-}$image:$tag" >/dev/null 2>&1 ||
    die "image $image:$tag is not on this host (rebuild: git checkout <that commit> && deploy/deploy.sh)"
done
log "rolling back from ${current:-unknown} to $tag"
roll_to "$tag" || die "rollback did not become healthy; see docs/runbook.md: full outage"
smoke_test || die "rolled back but the public smoke test failed"
# Record without turning the failed release into "previous".
mkdir -p "$STATE_DIR"
printf '%s\n' "$tag" >"$STATE_DIR/current"
printf 'APP_TAG=%s\n' "$tag" >"$STATE_DIR/release.env"
printf '%s %s (rollback from %s)\n' "$(date -u +%FT%TZ)" "$tag" "${current:-unknown}" >>"$STATE_DIR/history"
log "now running $tag"
dc ps
