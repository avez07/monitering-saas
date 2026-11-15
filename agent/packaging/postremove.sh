#!/bin/sh
# Leaves the config and credential alone (use `yuktiops-agent uninstall` to remove everything);
# only refreshes systemd.
set -e
if [ -d /run/systemd/system ]; then
  systemctl daemon-reload >/dev/null 2>&1 || true
fi
exit 0
