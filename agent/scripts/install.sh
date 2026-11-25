#!/usr/bin/env bash
# YuktiOps agent installer.
#
#   curl -fsSL https://get.yuktiops.com | sudo bash -s -- --key=yk_live_... [--setup=st_...]
#
# What it does: checks the machine, downloads the agent for this CPU, verifies its SHA-256
# checksum (and the cosign signature when cosign is installed), installs it as the "yuktiops"
# system user's service, registers this server and waits for the first data to arrive.
# Running it again upgrades in place. `--uninstall` removes everything.
#
# Options:
#   --key=KEY        Your account API key (or set YUKTIOPS_API_KEY). Needed for a new install.
#   --setup=ID       A setup profile id (st_...) created in the dashboard.
#   --name=NAME      Name shown in the dashboard (default: this server's host name).
#   --version=X.Y.Z  Install this version instead of the latest.
#   --base-url=URL   Where downloads come from (default https://downloads.yuktiops.com/agent).
#   --api=URL        The YuktiOps API (default https://api.yuktiops.com).
#   --app-url=URL    The dashboard address, used only for the final message.
#   --docker         Let the agent read Docker container stats (adds the user to group "docker").
#   --no-start       Install and register, but do not start the service (containers, images).
#   --uninstall      Remove the agent from this server. Add --keep-config to keep its settings.
#   --help           Show this text.
#
# Only https:// addresses are accepted, except http://localhost for local development.
set -euo pipefail

DEFAULT_BASE_URL="https://downloads.yuktiops.com/agent"
DEFAULT_API_URL="https://api.yuktiops.com"
BIN="/usr/local/bin/yuktiops-agent"
UNIT="/etc/systemd/system/yuktiops-agent.service"
CONFIG_DIR="/etc/yuktiops"
STATE_DIR="/var/lib/yuktiops"
SERVICE_USER="yuktiops"
WAIT_SECONDS=30

KEY="${YUKTIOPS_API_KEY:-}"
SETUP_ID=""
SERVER_NAME=""
VERSION=""
BASE_URL="$DEFAULT_BASE_URL"
API_URL="${YUKTIOPS_API_URL:-$DEFAULT_API_URL}"
APP_URL=""
WANT_DOCKER=0
NO_START=0
UNINSTALL=0
KEEP_CONFIG=0

TMP=""
FINGERPRINT=""
FAILURE_REPORTED=0
FETCH=""

say() { printf '%s\n' "$*"; }
step() { printf '==> %s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }

usage() {
  cat <<'USAGE'
YuktiOps agent installer

  curl -fsSL https://get.yuktiops.com | sudo bash -s -- --key=yk_live_... [--setup=st_...]

Options:
  --key=KEY        Your account API key (or set YUKTIOPS_API_KEY). Needed for a new install.
  --setup=ID       A setup profile id (st_...) created in the dashboard.
  --name=NAME      Name shown in the dashboard (default: this server's host name).
  --version=X.Y.Z  Install this version instead of the latest.
  --base-url=URL   Where downloads come from (default https://downloads.yuktiops.com/agent).
  --api=URL        The YuktiOps API (default https://api.yuktiops.com).
  --app-url=URL    The dashboard address, used only for the final message.
  --docker         Let the agent read Docker container stats (adds the user to group "docker").
  --no-start       Install and register, but do not start the service (containers, images).
  --uninstall      Remove the agent from this server. Add --keep-config to keep its settings.
  --help           Show this text.

Only https:// addresses are accepted, except http://localhost for local development.
USAGE
}

cleanup() {
  local code=$?
  if [ "$code" -ne 0 ] && [ "$FAILURE_REPORTED" -eq 0 ] && [ -n "$FINGERPRINT" ] && [ "$UNINSTALL" -eq 0 ]; then
    post_event failed "The installer stopped unexpectedly (exit code $code)."
  fi
  if [ -n "$TMP" ] && [ -d "$TMP" ]; then rm -rf "$TMP"; fi
  return "$code"
}

# die prints the problem, tells the dashboard (when possible) and stops.
die() {
  printf '\nError: %s\n' "$*" >&2
  if [ -n "$FINGERPRINT" ] && [ "$UNINSTALL" -eq 0 ]; then
    FAILURE_REPORTED=1
    post_event failed "$*"
  fi
  exit 1
}

# ---- helpers ------------------------------------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

# check_url accepts https://, and http:// only for this very machine.
check_url() {
  local what="$1" url="$2"
  case "$url" in
    https://*) ;;
    http://localhost | http://localhost:* | http://localhost/* | http://127.0.0.1 | http://127.0.0.1:* | http://127.0.0.1/* | 'http://[::1]'*) ;;
    *) die "$what must start with https:// (plain http is only allowed for localhost). Got: $url" ;;
  esac
}

# fetch URL DEST downloads a file, failing on HTTP errors.
fetch() {
  local url="$1" dest="$2"
  if [ "$FETCH" = curl ]; then
    curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 300 -o "$dest" "$url" </dev/null
  else
    wget -q --tries=3 --timeout=30 -O "$dest" "$url" </dev/null
  fi
}

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

# machine_id_fingerprint prints the same SHA-256 the agent uses to recognise this server.
machine_id_fingerprint() {
  local f id=""
  for f in /etc/machine-id /var/lib/dbus/machine-id "$CONFIG_DIR/machine-id"; do
    if [ -s "$f" ]; then
      id="$(tr -d '[:space:]' <"$f")"
      [ -n "$id" ] && break
    fi
  done
  if [ -z "$id" ]; then
    # Containers often have no machine-id: create the id the agent will fall back to.
    install -d -m 0750 "$CONFIG_DIR"
    id="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    printf '%s\n' "$id" >"$CONFIG_DIR/machine-id"
    chmod 0640 "$CONFIG_DIR/machine-id"
  fi
  printf '%s' "$id" | sha256sum | cut -d' ' -f1
}

# post_event STEP MESSAGE tells the dashboard how the install is going. It never fails the install.
post_event() {
  [ -n "$KEY" ] && [ -n "$FINGERPRINT" ] || return 0
  local msg body
  msg="$(printf '%s' "$2" | tr -cd 'A-Za-z0-9 .,:_/()=-' | cut -c1-280)"
  body="{\"fingerprint\":\"$FINGERPRINT\",\"step\":\"$1\",\"message\":\"$msg\"}"
  if [ "$FETCH" = curl ]; then
    curl -fsS --max-time 5 -o /dev/null -X POST -H "Authorization: Bearer $KEY" \
      -H 'Content-Type: application/json' --data "$body" "$API_URL/v1/install-events" </dev/null 2>/dev/null || true
  elif have wget; then
    wget -q -T 5 -O /dev/null --header="Authorization: Bearer $KEY" --header='Content-Type: application/json' \
      --post-data="$body" "$API_URL/v1/install-events" </dev/null 2>/dev/null || true
  fi
  return 0
}

# ---- argument parsing ---------------------------------------------------------------------------

parse_args() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --key=*) KEY="${arg#*=}" ;;
      --setup=*) SETUP_ID="${arg#*=}" ;;
      --name=*) SERVER_NAME="${arg#*=}" ;;
      --version=*) VERSION="${arg#*=}" ;;
      --base-url=*) BASE_URL="${arg#*=}" ;;
      --api=*) API_URL="${arg#*=}" ;;
      --app-url=*) APP_URL="${arg#*=}" ;;
      --docker) WANT_DOCKER=1 ;;
      --no-start) NO_START=1 ;;
      --uninstall) UNINSTALL=1 ;;
      --keep-config) KEEP_CONFIG=1 ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        printf 'Unknown option: %s\n\n' "$arg" >&2
        usage >&2
        exit 2
        ;;
    esac
  done
  BASE_URL="${BASE_URL%/}"
  API_URL="${API_URL%/}"
}

# ---- checks -------------------------------------------------------------------------------------

preflight() {
  step "Checking this server"
  [ "$(uname -s)" = Linux ] || die "This installer supports Linux only (found $(uname -s)). Windows and macOS are coming later."
  [ "$(id -u)" -eq 0 ] || die "Please run the installer as root, for example: curl -fsSL https://get.yuktiops.com | sudo bash -s -- --key=<your API key>"

  if have curl; then
    FETCH=curl
  elif have wget; then
    FETCH=wget
  else
    die "Neither curl nor wget is installed. Install one (for example: apt-get install -y curl) and run this again."
  fi
  have sha256sum || die "sha256sum is missing (it is part of coreutils). Install it and run this again."
  have tar || die "tar is missing. Install it and run this again."
  have gzip || die "gzip is missing. Install it and run this again."

  if [ "$NO_START" -eq 0 ] && [ ! -d /run/systemd/system ]; then
    cat >&2 <<'MSG'

This server is not running systemd, so the agent cannot be installed as a service here.
If this is a container or a minimal system, run the agent as a Docker container instead:

  docker run -d --name yuktiops-agent --restart unless-stopped \
    -e YUKTIOPS_API_KEY=<your API key> -v yuktiops-agent:/var/lib/yuktiops \
    yuktiops/yuktiops-agent:latest

(If Docker answers "denied", the image is not public yet: build it with
 docker build -t yuktiops-agent:local -f agent/Dockerfile agent   and use yuktiops-agent:local.)

(To install the files without starting a service, run this installer again with --no-start.)
MSG
    exit 1
  fi
}

detect_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) ARCH=amd64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    armv7l | armv8l | armv7) ARCH=armv7 ;;
    *) die "This CPU type ($(uname -m)) is not supported. The agent runs on x86-64, ARM64 and ARMv7 Linux." ;;
  esac
  OS_NAME="Linux"
  if [ -r /etc/os-release ]; then
    # shellcheck source=/dev/null
    OS_NAME="$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-Linux}")"
  fi
  say "    $OS_NAME, $ARCH"
}

# ---- download and verify ------------------------------------------------------------------------

resolve_version() {
  if [ -z "$VERSION" ]; then
    fetch "$BASE_URL/latest.json" "$TMP/latest.json" || die "Could not download $BASE_URL/latest.json. Check that this server can reach the internet over HTTPS."
    VERSION="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$TMP/latest.json" | head -n 1 | sed 's/.*:[[:space:]]*"\([^"]*\)"/\1/')"
  fi
  VERSION="${VERSION#v}"
  case "$VERSION" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) die "The version \"$VERSION\" does not look right (expected something like 0.4.1)." ;;
  esac
  case "$VERSION" in
    *[!0-9A-Za-z.+-]*) die "The version \"$VERSION\" contains unexpected characters." ;;
  esac
}

download_and_verify() {
  local name="yuktiops-agent_${VERSION}_linux_${ARCH}.tar.gz"
  local dir="$BASE_URL/v$VERSION"
  step "Downloading YuktiOps agent $VERSION"
  fetch "$dir/$name" "$TMP/$name" || die "Could not download $dir/$name. Check the version and that this server can reach the internet over HTTPS."
  fetch "$dir/checksums.txt" "$TMP/checksums.txt" || die "Could not download $dir/checksums.txt."
  post_event downloaded "Downloaded $name"

  step "Verifying the download"
  local expected actual
  expected="$(awk -v f="$name" '$2 == f || $2 == "*" f { print $1; exit }' "$TMP/checksums.txt")"
  [ -n "$expected" ] || die "checksums.txt does not list $name. The download was not installed."
  actual="$(sha256_of "$TMP/$name")"
  if [ "$expected" != "$actual" ]; then
    die "The downloaded file does not match its SHA-256 checksum, so it was NOT installed (expected $expected, got $actual). The download may be corrupted or tampered with. Try again, and contact support if it keeps happening."
  fi
  say "    SHA-256 matches ($actual)"

  if have cosign; then
    if fetch "$dir/checksums.txt.sig" "$TMP/checksums.txt.sig" 2>/dev/null && fetch "$dir/checksums.txt.pem" "$TMP/checksums.txt.pem" 2>/dev/null; then
      cosign verify-blob --certificate "$TMP/checksums.txt.pem" --signature "$TMP/checksums.txt.sig" \
        --certificate-identity-regexp '^https://github.com/yuktiops/' \
        --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
        "$TMP/checksums.txt" >/dev/null 2>&1 || die "The cosign signature of checksums.txt is NOT valid. Nothing was installed."
      say "    cosign signature is valid"
    else
      warn "cosign is installed but this release has no signature; skipping the signature check."
    fi
  fi
  post_event verified "Checksum verified"

  tar -xzf "$TMP/$name" -C "$TMP" yuktiops-agent yuktiops-agent.service || die "The downloaded archive is not what was expected."
  [ -x "$TMP/yuktiops-agent" ] || chmod 0755 "$TMP/yuktiops-agent"
}

# ---- install ------------------------------------------------------------------------------------

ensure_user_and_dirs() {
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    local nologin=/usr/sbin/nologin
    [ -x "$nologin" ] || nologin=/sbin/nologin
    if have useradd; then
      useradd --system --user-group --no-create-home --home-dir /nonexistent --shell "$nologin" "$SERVICE_USER"
    elif have adduser; then
      adduser --system --group --no-create-home --home /nonexistent --shell "$nologin" "$SERVICE_USER"
    else
      die "Cannot create the \"$SERVICE_USER\" user (neither useradd nor adduser found)."
    fi
  fi
  install -d -m 0750 -o root -g "$SERVICE_USER" "$CONFIG_DIR"
  install -d -m 0755 -o "$SERVICE_USER" -g "$SERVICE_USER" "$STATE_DIR"
  # Settings kept from an earlier install must stay readable by the (possibly re-created) group.
  local f
  for f in credential agent.yaml machine-id environment; do
    if [ -e "$CONFIG_DIR/$f" ]; then
      chown "root:$SERVICE_USER" "$CONFIG_DIR/$f"
      chmod 0640 "$CONFIG_DIR/$f"
    fi
  done
  if [ "$WANT_DOCKER" -eq 1 ]; then
    if getent group docker >/dev/null 2>&1; then
      usermod -aG docker "$SERVICE_USER"
      say "    The agent can now read Docker container stats (read-only use of the Docker socket)."
    else
      warn "--docker was given but this server has no \"docker\" group; Docker is not installed or uses another setup."
    fi
  fi
}

install_files() {
  step "Installing"
  ensure_user_and_dirs
  local was_running=0
  if [ -d /run/systemd/system ] && systemctl is-active --quiet yuktiops-agent 2>/dev/null; then was_running=1; fi
  # Replace the program atomically, so a running agent is never left half-written.
  install -m 0755 -o root -g root "$TMP/yuktiops-agent" "$BIN.new"
  mv -f "$BIN.new" "$BIN"
  if [ -d /run/systemd/system ]; then
    install -m 0644 -o root -g root "$TMP/yuktiops-agent.service" "$UNIT"
    systemctl daemon-reload
  fi
  say "    $BIN ($("$BIN" version | cut -d' ' -f1-2))"
  post_event installed "Installed version $VERSION"
  WAS_RUNNING="$was_running"
}

register_server() {
  if [ -z "$KEY" ]; then
    if [ -s "$CONFIG_DIR/credential" ]; then
      say "    This server is already registered; keeping its credential."
      return 0
    fi
    die "No API key given. Run again with --key=<your API key> (create one in the dashboard under Settings, API key)."
  fi
  step "Registering this server"
  local args=(register "--api=$API_URL")
  [ -n "$SETUP_ID" ] && args+=("--setup=$SETUP_ID")
  [ -n "$SERVER_NAME" ] && args+=("--name=$SERVER_NAME")
  # The key goes through the environment, not the command line, so it never shows in a process list.
  YUKTIOPS_API_KEY="$KEY" "$BIN" "${args[@]}" || die "Registration failed (see the message above)."
}

# The Docker socket is root-equivalent, so the agent's user joins group "docker" only when the setup
# profile (cached by the agent as remote-config.json) turned container monitoring on, or --docker was given.
grant_docker_if_enabled() {
  local cache="$STATE_DIR/remote-config.json" waited=0
  if [ "$WANT_DOCKER" -ne 1 ]; then
    while [ ! -s "$cache" ] && [ "$waited" -lt 10 ]; do sleep 1; waited=$((waited + 1)); done
    [ -s "$cache" ] && grep -Eq '"docker" *: *true' "$cache" || return 0
  fi
  getent group docker >/dev/null 2>&1 || { warn "Container monitoring is on but this server has no \"docker\" group; Docker is not installed or uses another setup."; return 0; }
  id -nG "$SERVICE_USER" | tr ' ' '\n' | grep -qx docker && return 0
  usermod -aG docker "$SERVICE_USER"
  say "    Added $SERVICE_USER to group \"docker\" (read-only use of the Docker socket) and restarting the agent."
  systemctl restart yuktiops-agent
}

start_and_wait() {
  if [ "$NO_START" -eq 1 ]; then
    say ""
    say "Installed and registered. The service was not started (--no-start)."
    say "Start it with: sudo systemctl enable --now yuktiops-agent"
    return 0
  fi
  step "Starting the agent"
  touch "$TMP/started"
  sleep 1 # state.json must be newer than the marker
  systemctl enable yuktiops-agent >/dev/null 2>&1 || die "Could not enable the service. Run: systemctl status yuktiops-agent"
  if [ "${WAS_RUNNING:-0}" -eq 1 ]; then
    systemctl restart yuktiops-agent
  else
    systemctl start yuktiops-agent || die "The service did not start. Run: journalctl -u yuktiops-agent -n 50"
  fi
  post_event service_started "Service started"

  say "    Waiting up to ${WAIT_SECONDS}s for the first data..."
  local waited=0
  while [ "$waited" -lt "$WAIT_SECONDS" ]; do
    if [ "$STATE_DIR/state.json" -nt "$TMP/started" ] && "$BIN" status >/dev/null 2>&1; then
      say ""
      grant_docker_if_enabled
      say "Connected. This server is sending data to YuktiOps."
      if [ -n "$APP_URL" ]; then say "Open $APP_URL/servers to see it."; fi
      say "Check it any time with: yuktiops-agent status"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  say ""
  say "The agent is installed and running, but no data has reached YuktiOps yet. Here is what the doctor found:"
  say ""
  "$BIN" doctor --api="$API_URL" || true
  exit 3
}

# ---- uninstall ----------------------------------------------------------------------------------

do_uninstall() {
  [ "$(id -u)" -eq 0 ] || die "Please run the uninstaller as root (use sudo)."
  step "Removing the YuktiOps agent"
  if [ -x "$BIN" ]; then
    local flags=()
    [ "$KEEP_CONFIG" -eq 1 ] && flags+=(--keep-config)
    "$BIN" uninstall "${flags[@]}"
    return $?
  fi
  # The program is already gone: remove what is left by hand.
  if [ -d /run/systemd/system ]; then
    systemctl disable --now yuktiops-agent >/dev/null 2>&1 || true
  fi
  rm -f "$UNIT"
  [ -d /run/systemd/system ] && systemctl daemon-reload
  rm -rf "$STATE_DIR"
  if [ "$KEEP_CONFIG" -eq 0 ]; then rm -rf "$CONFIG_DIR"; fi
  if id "$SERVICE_USER" >/dev/null 2>&1; then userdel "$SERVICE_USER" 2>/dev/null || true; fi
  if getent group "$SERVICE_USER" >/dev/null 2>&1; then groupdel "$SERVICE_USER" 2>/dev/null || true; fi
  say "The YuktiOps agent was removed from this server."
  return 0
}

# ---- main ---------------------------------------------------------------------------------------

main() {
  parse_args "$@"
  if [ "$UNINSTALL" -eq 1 ]; then
    do_uninstall
    return $?
  fi
  check_url "--base-url" "$BASE_URL"
  check_url "--api" "$API_URL"
  preflight
  TMP="$(mktemp -d)"
  trap cleanup EXIT
  FINGERPRINT="$(machine_id_fingerprint)"
  post_event started "Installer started"
  detect_arch
  resolve_version
  download_and_verify
  install_files
  register_server
  start_and_wait
}

main "$@"
