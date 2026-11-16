---
title: "Install: .deb package"
description: "Step-by-step: install the YuktiOps agent on Ubuntu or Debian from a .deb package."
group: Start here
order: 2.2
---

For Ubuntu and Debian when you prefer a normal package.

## Steps

1. **Download the package** from the dashboard's **Download** tab. Pick `amd64` for most servers, `arm64` for ARM. Upload it to the server (for example with `scp`).

2. **Install it.**

   ```
   sudo dpkg -i yuktiops-agent_<version>_amd64.deb
   ```

   What it does: unpacks the program and service file and creates the `yuktiops` user. Expected: `Setting up yuktiops-agent ...`.

3. **Register the server** with your key. This swaps the key for a credential only this server holds.

   ```
   sudo yuktiops-agent register --key=yk_live_...
   ```

   Expected: `Registered. Credential saved.`

4. **Start it now and at every boot.**

   ```
   sudo systemctl enable --now yuktiops-agent
   ```

5. **Check it worked.**

   ```
   yuktiops-agent status
   ```

   Expected: `Running, Connected, last data sent ... seconds ago`.

## Something went wrong?

- **`dpkg: dependency problems`**: the agent has none; you likely downloaded the wrong architecture. Check with `uname -m`.
- **`register` fails**: check the key and the server clock. Run `sudo yuktiops-agent doctor`.
- **Status says not connected**: see [No data](/docs/troubleshooting-no-data).

## Upgrade and uninstall

Upgrade: `sudo dpkg -i` the newer file; your settings stay. Uninstall: `sudo apt remove yuktiops-agent` (add `--purge` to delete settings), then remove the server in the dashboard.

## What happens on your server

See [One command](/docs/install-one-command): same program, same service, same outgoing-only HTTPS connection.
