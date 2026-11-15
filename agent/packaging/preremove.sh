#!/bin/sh
# deb: $1 is "remove", "upgrade" or "deconfigure"; rpm: $1 is the number of copies left (0 = removal).
set -e
case "$1" in
  remove|purge|0)
    if [ -d /run/systemd/system ]; then
      systemctl disable --now yuktiops-agent.service >/dev/null 2>&1 || true
    fi
    ;;
esac
exit 0
