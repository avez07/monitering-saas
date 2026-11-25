#!/usr/bin/env bash
# Shared helpers for deploy/*.sh and deploy/backup/*.sh. Source it; do not run it.
# shellcheck disable=SC2034  # variables are used by the scripts that source this file
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE=${ENV_FILE:-$ROOT/.env.production}
COMPOSE_FILE=${COMPOSE_FILE:-$ROOT/docker-compose.prod.yml}
STATE_DIR=${STATE_DIR:-$ROOT/.deploy}
STANZA=yuktiops

# release.env (written by deploy.sh/rollback.sh) pins APP_TAG so a plain "up -d" never moves to :latest.
dc() {
  local args=(-f "$COMPOSE_FILE" --env-file "$ENV_FILE")
  # Extra compose files, space separated: COMPOSE_OVERRIDE="docker-compose.traefik.yml docker-compose.disk-backup.yml"
  local f
  for f in ${COMPOSE_OVERRIDE:-}; do args+=(-f "$f"); done
  [ -f "$STATE_DIR/release.env" ] && args+=(--env-file "$STATE_DIR/release.env")
  docker compose "${args[@]}" "$@"
}
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() {
  log "ERROR: $*" >&2
  exit 1
}
need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }
# Run pgbackrest inside the running db container as the postgres user.
pgbr() { dc exec -T -u postgres db pgbackrest --stanza="$STANZA" "$@"; }
# Read one KEY from the env file without sourcing it (values may contain shell metacharacters).
env_value() { grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true; }
# Best-effort ping to a monitoring URL (healthchecks.io style). Never fails the caller.
ping_url() { if [ -n "${1:-}" ]; then curl -fsS -m 10 --retry 2 -o /dev/null "$1" || true; fi; }

# Worker role services (docker-compose.prod.yml); each has its own /healthz healthcheck.
WORKER_SERVICES="worker-ingest worker-checks worker-alerts worker-notify worker-housekeeping"

# wait_healthy <service> <timeout-seconds>: poll the container health status of every replica.
wait_healthy() {
  local service=$1 timeout=${2:-120} waited=0 ids id status bad
  ids=$(dc ps -q "$service")
  [ -n "$ids" ] || return 1
  while [ "$waited" -lt "$timeout" ]; do
    bad=0
    for id in $ids; do
      status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo missing)
      case "$status" in
        healthy | running) ;;
        unhealthy | exited | dead | missing) if [ "$waited" -ge 30 ]; then return 1; fi; bad=1 ;;
        *) bad=1 ;;
      esac
    done
    [ "$bad" = 0 ] && return 0
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

# roll_to <tag>: restart api (2 replicas), the worker roles and web on the given image tag, one service at
# a time, each health-gated. The API goes first so the workers never run newer code against an API that
# failed. Compose recreates replicas one by one, and Caddy only routes to healthy ones.
roll_to() {
  local tag=$1 svc
  export APP_TAG=$tag
  dc up -d --no-build --no-deps pgbouncer || return 1
  dc up -d --no-build --no-deps api || return 1
  wait_healthy api 120 || return 1
  for svc in $WORKER_SERVICES; do
    dc up -d --no-build --no-deps "$svc" || return 1
    wait_healthy "$svc" 90 || return 1
  done
  dc up -d --no-build --no-deps web || return 1
  wait_healthy web 60 || return 1
}

# smoke_test: hit the public URLs (skipped when not set, e.g. on a staging box without DNS).
smoke_test() {
  local api app
  api=$(env_value HEALTH_URL_API)
  app=$(env_value HEALTH_URL_APP)
  if [ -n "$api" ]; then curl -fsS -m 15 --retry 5 --retry-delay 3 --retry-connrefused -o /dev/null "$api" || return 1; fi
  if [ -n "$app" ]; then curl -fsS -m 15 --retry 5 --retry-delay 3 --retry-connrefused -o /dev/null "$app" || return 1; fi
  return 0
}

record_release() {
  local tag=$1
  mkdir -p "$STATE_DIR"
  if [ -f "$STATE_DIR/current" ] && [ "$(cat "$STATE_DIR/current")" != "$tag" ]; then cp "$STATE_DIR/current" "$STATE_DIR/previous"; fi
  printf '%s\n' "$tag" >"$STATE_DIR/current"
  printf 'APP_TAG=%s\n' "$tag" >"$STATE_DIR/release.env"
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$tag" >>"$STATE_DIR/history"
}
