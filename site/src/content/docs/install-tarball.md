---
title: "Install: tarball (.tar.gz)"
description: "Step-by-step: install the YuktiOps agent by hand from a .tar.gz on any Linux."
group: Start here
order: 2.4
---

For any Linux with systemd where you want to control every step.

## Steps

1. **Download** the `.tar.gz` for your CPU (`uname -m` shows it) from the **Download** tab and copy it to the server.

2. **Extract it.**

   ```
   tar -xzf yuktiops-agent_<version>_linux_amd64.tar.gz
   ```

   Expected: files `yuktiops-agent` and `yuktiops-agent.service`.

3. **Put the program on your PATH.**

   ```
   sudo install -m 0755 yuktiops-agent /usr/local/bin/yuktiops-agent
   ```

4. **Create the user and folders.** The agent runs as its own user with no login.

   ```
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin yuktiops
   sudo mkdir -p /etc/yuktiops /var/lib/yuktiops
   sudo chown yuktiops: /var/lib/yuktiops
   ```

5. **Install the service file.**

   ```
   sudo cp yuktiops-agent.service /etc/systemd/system/
   sudo systemctl daemon-reload
   ```

6. **Register the server.**

   ```
   sudo yuktiops-agent register --key=yk_live_...
   ```

7. **Start it.**

   ```
   sudo systemctl enable --now yuktiops-agent
   ```

8. **Check it worked.**

   ```
   yuktiops-agent status
   ```

   Expected: `Running, Connected, last data sent ... seconds ago`.

## Something went wrong?

- **`Permission denied` on the state folder**: repeat the `chown` in step 4.
- **`Unit yuktiops-agent.service not found`**: repeat step 5.
- **Not connected**: `sudo yuktiops-agent doctor`.

## Upgrade and uninstall

Upgrade: repeat steps 2 and 3, then `sudo systemctl restart yuktiops-agent`. Uninstall: `sudo yuktiops-agent uninstall`, then remove the server in the dashboard.

## What happens on your server

See [One command](/docs/install-one-command).
