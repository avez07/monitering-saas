---
title: "Install: Docker on Linux"
description: "Step-by-step: run the YuktiOps agent as a Docker container on a Linux server and monitor the host and its containers."
group: Start here
order: 2.5
---

Run the agent as a container. With the options below it sees the real host, not just the container.

## Steps

1. **Check Docker works:** `docker version`. If it says permission denied, prefix commands with `sudo`.

2. **Run the agent.**

   ```
   docker run -d --name yuktiops-agent --restart unless-stopped \
     --pid host --network host \
     -v /:/host:ro -e HOST_ROOT=/host \
     -v yuktiops-agent:/var/lib/yuktiops \
     -e YUKTIOPS_API_KEY=yk_live_... \
     ghcr.io/yuktiops/agent
   ```

   What each part does:

   - `-d --restart unless-stopped`: run in the background and come back after reboots.
   - `--pid host`: lets the agent see the host's programs (for the busiest-programs list).
   - `--network host`: reports the host's real network interfaces.
   - `-v /:/host:ro -e HOST_ROOT=/host`: shows the host's disks, read-only.
   - `-v yuktiops-agent:/var/lib/yuktiops`: keeps the credential so it survives upgrades.
   - `-e YUKTIOPS_API_KEY=`: your key. The container registers itself on first start.

3. **Optional: container monitoring.** Add this line to the command:

   ```
   -v /var/run/docker.sock:/var/run/docker.sock:ro
   ```

   The Docker socket is powerful (close to root on most systems). The agent only reads stats. Add it only if you want containers monitored.

4. **Check it worked.**

   ```
   docker exec yuktiops-agent yuktiops-agent status
   ```

   Expected: `Running, Connected, last data sent ... seconds ago`.

## Monitor Docker containers without a server

You do not need to install anything on the host OS: run the container above, with the Docker socket line, on any machine that runs Docker, including a small VPS or a NAS. The dashboard then shows the machine plus each container.

## Something went wrong?

- **`denied` or `pull access denied`**: the image is not public yet (or you are not logged in). Either `docker login ghcr.io`, or build it from the repository and use the tag `yuktiops-agent:local` in the command above: `docker build -t yuktiops-agent:local -f agent/Dockerfile agent` (same command in PowerShell and bash, run from the repo root).
- **Container keeps restarting**: `docker logs yuktiops-agent`.
- **Docker permission error in the dashboard**: see [Docker permission denied](/docs/troubleshooting-docker-permission).
- **Numbers look like the container, not the host**: you left out `--pid host`, `--network host` or the `/host` mount.

## Upgrade and uninstall

Upgrade: `docker pull ghcr.io/yuktiops/agent`, then `docker rm -f yuktiops-agent` and run step 2 again (the volume keeps your credential). Uninstall: `docker rm -f yuktiops-agent` and `docker volume rm yuktiops-agent`, then remove the server in the dashboard.

## What happens on your server

The container reads host numbers through the read-only mounts and sends them over outgoing HTTPS. It opens no ports and cannot change your files.
