---
title: "Install: Docker Desktop on Windows"
description: "Step-by-step: run the YuktiOps agent with Docker Desktop on Windows, in PowerShell or Git Bash, and fix the Git Bash path error."
group: Start here
order: 2.6
---

**Important:** Docker Desktop runs containers inside a small Linux virtual machine. The agent monitors **that Linux VM** (and the containers in it), **not your Windows PC**. It is good for trying YuktiOps and for watching your Docker workloads. It does not report Windows CPU, memory or disks.

## Steps (PowerShell)

1. **Start Docker Desktop** and wait until it says Running. Check: `docker version`.

2. **Run the agent.** In PowerShell the backtick continues a line:

   ```
   docker run -d --name yuktiops-agent --restart unless-stopped `
     --pid host --network host `
     -v /:/host:ro -e HOST_ROOT=/host `
     -v yuktiops-agent:/var/lib/yuktiops `
     -v /var/run/docker.sock:/var/run/docker.sock:ro `
     -e YUKTIOPS_API_KEY=yk_live_... `
     yuktiops/yuktiops-agent
   ```

   What it does: starts the agent in the background, gives it a read-only view of the VM (`/host`), and, with the `docker.sock` line, lets it read container stats. Leave that line out if you do not want containers monitored.

3. **Check it worked.**

   ```
   docker exec yuktiops-agent yuktiops-agent status
   ```

   Expected: `Running, Connected, last data sent ... seconds ago`.

## Steps (Git Bash)

Git Bash rewrites Linux-looking paths such as `/var/run/docker.sock` into Windows paths. Switch that off for the command with `MSYS_NO_PATHCONV=1`:

```
MSYS_NO_PATHCONV=1 docker run -d --name yuktiops-agent --restart unless-stopped \
  --pid host --network host \
  -v /:/host:ro -e HOST_ROOT=/host \
  -v yuktiops-agent:/var/lib/yuktiops \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -e YUKTIOPS_API_KEY=yk_live_... \
  yuktiops/yuktiops-agent
```

### The error "mkdir C:\Program Files\Git\var: Access is denied"

Git Bash turned `/var/run/docker.sock` into `C:\Program Files\Git\var\run\docker.sock`, and Docker tried to create that folder, which Windows does not allow. Nothing is wrong with your key or Docker. Put `MSYS_NO_PATHCONV=1` in front of the command (as above), or use PowerShell. Remove any half-created container first: `docker rm -f yuktiops-agent`.

## Something went wrong?

- **Cannot connect to the Docker engine**: Docker Desktop is not running yet.
- **Server shows up with a Linux hostname such as `docker-desktop`**: expected, that is the VM.
- **`denied` or `pull access denied`**: the image is not public yet (or you are not logged in). Either `docker login ghcr.io`, or build it from the repository and use the tag `yuktiops-agent:local` in the command above: `docker build -t yuktiops-agent:local -f agent/Dockerfile agent` (same command in PowerShell and bash, run from the repo root).
- **No data**: `docker logs yuktiops-agent`, then see [No data](/docs/troubleshooting-no-data).

## Upgrade and uninstall

Upgrade: `docker pull yuktiops/yuktiops-agent`, `docker rm -f yuktiops-agent`, run the command again. Uninstall: `docker rm -f yuktiops-agent` and `docker volume rm yuktiops-agent`, then remove the server in the dashboard.

## What happens on your server

The agent runs inside Docker's Linux VM, reads that VM's numbers and your containers' stats, and sends them out over HTTPS. Nothing is installed on Windows itself.
