---
title: "Install: one command"
description: "Step-by-step: install the YuktiOps agent on any Linux server with a single command."
group: Start here
order: 2.1
---

The fastest way. Works on any Linux with systemd (Ubuntu, Debian, RHEL, Rocky, Alma, Amazon Linux and more).

## Steps

1. **Open a terminal on your server.** Usually `ssh youruser@your-server-ip`. You need `sudo` rights.

2. **Copy the command from the dashboard's Add server page.** It already contains your key.

   ```
   curl -fsSL https://get.yuktiops.com | sudo bash -s -- --key=yk_live_...
   ```

   What it does: `curl` downloads our install script, `sudo bash` runs it as an administrator, and `--key=` tells it which account the server belongs to.

3. **Watch the output.** Expected:

   ```
   Detected linux/amd64, systemd
   Downloading yuktiops-agent ... ok
   Checksum verified
   Installed service yuktiops-agent
   Registered as "web-1"
   Waiting for first data ... connected
   ```

4. **Check it worked.**

   ```
   yuktiops-agent status
   ```

   Expected: `Running, Connected, last data sent 12 seconds ago`. The server appears in the dashboard within a minute.

Options: `--name=web-1`, `--docker` (container stats), `--version=0.4.1`, `--no-start`.

## Something went wrong?

- **`curl: command not found`**: install curl (`sudo apt install curl` or `sudo dnf install curl`).
- **`Permission denied`**: run with `sudo`.
- **No data after a few minutes**: run `sudo yuktiops-agent doctor`. See [No data](/docs/troubleshooting-no-data) and [Firewall and proxy](/docs/troubleshooting-firewall-proxy).

## Upgrade and uninstall

Upgrade: run the same command again. Uninstall: `sudo yuktiops-agent uninstall`, then remove the server in the dashboard.

## What happens on your server

The script installs one program in `/usr/local/bin`, creates a user called `yuktiops` with no login, and a systemd service that starts at boot. The agent regularly reads CPU, memory, disk and network numbers and sends them over HTTPS to us. It only makes outgoing connections; nothing listens on your server.
