---
title: Config file reference
description: "The agent.yaml settings file, other files the agent uses, and environment variables."
group: Using YuktiOps
order: 4
---

You normally never edit these files. The installer writes them and the dashboard manages what is collected. This page is for the curious and for locked-down networks.

## Files

| Path | Contents |
| --- | --- |
| `/usr/local/bin/yuktiops-agent` | The program |
| `/etc/yuktiops/agent.yaml` | Settings (below) |
| `/etc/yuktiops/credential` | This server's own credential (never your account API key) |
| `/etc/yuktiops/environment` | Optional. Proxy settings for the service |
| `/var/lib/yuktiops/` | Offline buffer, cached settings and status (no secrets) |

## agent.yaml

After editing, run `sudo systemctl restart yuktiops-agent`. Unknown keys are ignored.

```yaml
# Where the agent sends data. HTTPS only.
api_url: "https://api.yuktiops.com"

# Name this server was registered with, and its id (informational).
name: "web-1"
agent_id: "0b8f8c4e-1111-2222-3333-444455556666"

# Setup profile chosen in the dashboard wizard (informational).
setup_id: "st_0123456789abcdef01234567"

# Optional outbound proxy.
# proxy: "http://proxy.example.com:3128"
```

## Proxy

If your server must use a web proxy, either set `proxy` in `agent.yaml`, or put these lines in `/etc/yuktiops/environment`:

```
HTTPS_PROXY=http://proxy.example.com:3128
NO_PROXY=localhost
```

## What is collected

Which collectors are on and how often they run (the send and sample intervals) is managed from the dashboard. The agent picks up changes by itself. Remote settings can only switch built-in, read-only collectors on or off and change their timing. The agent never runs commands from us.

## Environment variables

Mostly for containers and development: `YUKTIOPS_API_KEY`, `YUKTIOPS_API_URL`, `YUKTIOPS_NAME`, `YUKTIOPS_CONFIG_DIR`, `YUKTIOPS_STATE_DIR`.
