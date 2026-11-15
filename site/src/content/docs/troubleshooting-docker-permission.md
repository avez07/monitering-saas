---
title: Docker permission denied
description: "Fix the agent is not allowed to read Docker error in YuktiOps."
group: Troubleshooting
order: 15
---

**The agent isn't allowed to read Docker.** Container monitoring is on, but the agent's user (`yuktiops`) cannot open the Docker socket at `/var/run/docker.sock`.

## Fix

Add the agent's user to the `docker` group and restart:

```
sudo usermod -aG docker yuktiops
sudo systemctl restart yuktiops-agent
```

Or turn container monitoring off in the server's settings if you do not need it.

## Why this is opt-in

Access to the Docker socket is powerful, on most systems close to root. The agent only reads container statistics, but we never grant this access unless you ask for it.
