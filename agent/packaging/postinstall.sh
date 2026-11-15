#!/bin/sh
# Runs after the .deb / .rpm is installed or upgraded. It prepares the account and directories
# and loads the unit. It does not start the service: the agent needs registering first.
set -e

if ! getent group yuktiops >/dev/null 2>&1; then
  groupadd --system yuktiops 2>/dev/null || addgroup --system yuktiops
fi
if ! getent passwd yuktiops >/dev/null 2>&1; then
  nologin=/usr/sbin/nologin
  [ -x "$nologin" ] || nologin=/sbin/nologin
  useradd --system --gid yuktiops --no-create-home --home-dir /nonexistent --shell "$nologin" yuktiops 2>/dev/null ||
    adduser --system --ingroup yuktiops --no-create-home --home /nonexistent --shell "$nologin" yuktiops
fi

install -d -m 0750 -o root -g yuktiops /etc/yuktiops
install -d -m 0755 -o yuktiops -g yuktiops /var/lib/yuktiops
# Files from an earlier install (kept config) must stay readable by the service group.
for f in /etc/yuktiops/credential /etc/yuktiops/agent.yaml /etc/yuktiops/machine-id /etc/yuktiops/environment; do
  [ -e "$f" ] && chown root:yuktiops "$f" && chmod 0640 "$f"
done
true

if [ -d /run/systemd/system ]; then
  systemctl daemon-reload || true
  # An upgrade of a running agent restarts it; a fresh install stays stopped until registered.
  systemctl try-restart yuktiops-agent.service || true
fi

cat <<'MSG'

YuktiOps agent installed. To connect this server:
  sudo yuktiops-agent register --key=<your API key>
  sudo systemctl enable --now yuktiops-agent

MSG
exit 0
