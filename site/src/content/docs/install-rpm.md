---
title: "Install: .rpm package"
description: "Step-by-step: install the YuktiOps agent on RHEL, Rocky, Alma, CentOS or Amazon Linux from a .rpm."
group: Start here
order: 2.3
---

For RHEL, Rocky, Alma, CentOS and Amazon Linux.

## Steps

1. **Download the package** from the dashboard's **Download** tab: `x86_64` for most servers, `aarch64` for ARM. Copy it to the server.

2. **Install it.**

   ```
   sudo rpm -i yuktiops-agent-<version>.x86_64.rpm
   ```

   What it does: unpacks the program and service file and creates the `yuktiops` user. It prints nothing on success.

3. **Register the server.**

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

- **`package ... is already installed`**: use the upgrade command below.
- **`register` fails**: check the key and the clock (`sudo yuktiops-agent doctor`).
- **Service will not start**: run `sudo journalctl -u yuktiops-agent` and `doctor`; see [Troubleshooting](/docs/troubleshooting).

## Upgrade and uninstall

Upgrade: `sudo rpm -U yuktiops-agent-<newversion>.x86_64.rpm`. Uninstall: `sudo rpm -e yuktiops-agent`, then remove the server in the dashboard.

## What happens on your server

See [One command](/docs/install-one-command).
