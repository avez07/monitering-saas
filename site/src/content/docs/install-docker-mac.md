---
title: "Install: Docker Desktop on macOS"
description: "Step-by-step: run the YuktiOps agent with Docker Desktop on a Mac to monitor Docker's Linux VM and containers."
group: Start here
order: 2.7
---

**Important:** like Windows, Docker Desktop on a Mac runs containers in a hidden Linux VM. The agent monitors **that VM and its containers, not macOS itself**.

## Steps

1. **Start Docker Desktop** and wait for it to say Running. Check in Terminal: `docker version`.

2. **Run the agent.**

   ```
   docker run -d --name yuktiops-agent --restart unless-stopped \
     --pid host --network host \
     -v /:/host:ro -e HOST_ROOT=/host \
     -v yuktiops-agent:/var/lib/yuktiops \
     -v /var/run/docker.sock:/var/run/docker.sock:ro \
     -e YUKTIOPS_API_KEY=yk_live_... \
     ghcr.io/yuktiops/agent
   ```

   What it does: runs the agent in the background and gives it a read-only view of the VM. The `docker.sock` line enables container stats; remove it if you do not want that.

3. **Check it worked.**

   ```
   docker exec yuktiops-agent yuktiops-agent status
   ```

   Expected: `Running, Connected, last data sent ... seconds ago`.

## Something went wrong?

- **Cannot connect to the Docker daemon**: start Docker Desktop.
- **Apple Silicon platform warning**: add `--platform linux/arm64` to the command.
- **No data**: `docker logs yuktiops-agent` and [No data](/docs/troubleshooting-no-data).

## Upgrade and uninstall

If the pull says `denied`, the image is not public yet: `docker login ghcr.io`, or build it with `docker build -t yuktiops-agent:local -f agent/Dockerfile agent` and use `yuktiops-agent:local` as the image.

Upgrade: `docker pull ghcr.io/yuktiops/agent`, `docker rm -f yuktiops-agent`, run step 2 again. Uninstall: `docker rm -f yuktiops-agent` and `docker volume rm yuktiops-agent`, then remove the server in the dashboard.

## What happens on your server

The agent reads the VM's numbers and container stats, then sends them out over HTTPS. Nothing is installed on macOS.
