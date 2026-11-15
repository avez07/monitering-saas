# YuktiOps agent

A single static Go binary, `yuktiops-agent`, that reads system statistics and sends them to YuktiOps over outbound HTTPS. No dependencies, no open ports, about 7 MB (3 MB compressed).

- Linux amd64, arm64 and armv7. Runs as the unprivileged user `yuktiops` under systemd (`Restart=always`, starts on boot).
- Collects: CPU, memory, swap, disk per mount, disk I/O, network per interface, load, uptime and the top 10 processes. Every 30 seconds by default.
- Target: under 25 MB RAM and 1% CPU. systemd enforces hard caps (`MemoryMax=64M`, `CPUQuota=10%`).

## Install

```
curl -fsSL https://get.yuktiops.com | sudo bash -s -- --key=yk_live_... [--setup=st_...]
```

The script checks the machine, downloads the right build, **verifies its SHA-256** (and the cosign signature when `cosign` is installed), installs the service, registers the server and waits up to 30 seconds for the first data. Running it again upgrades in place. Options: `--version=`, `--name=`, `--docker` (let the agent read Docker stats), `--no-start`, `--base-url=`, `--api=`. Remove everything with `... | sudo bash -s -- --uninstall` or `sudo yuktiops-agent uninstall`.

Or use a package from the dashboard's Download tab:

```
sudo dpkg -i yuktiops-agent_<version>_amd64.deb        # or: sudo rpm -i yuktiops-agent-<version>.x86_64.rpm
sudo yuktiops-agent register --key=yk_live_...
sudo systemctl enable --now yuktiops-agent
```

Docker: `docker run -d --name yuktiops-agent --restart unless-stopped -e YUKTIOPS_API_KEY=yk_live_... -v yuktiops-agent:/var/lib/yuktiops ghcr.io/yuktiops/agent` (the image registers itself on first start; the key is not stored). It reports the container's own view of the system.


## Containers and services (opt-in, read-only)

Switched on from the setup profile in the dashboard (`collectors.docker`, `collectors.services`); nothing is collected until then. Both run in their own goroutine on the send interval, so a slow Docker daemon or a hanging port never delays sampling or sending.

- **Docker** (`collectors.docker`): GET-only calls over `/var/run/docker.sock` (container list, inspect, one-shot stats; no SDK, other HTTP methods are refused in code). Reports state, restart count, CPU % (from counter deltas between two collections, so the first value appears one interval after start), memory without page cache, memory limit and OOM flag. At most 100 containers, 4 requests at a time, 20 s overall timeout. If the socket is not readable it reports `docker_socket_denied` (once an hour at most) and keeps running. The installer adds the `yuktiops` user to group `docker` only when the profile has Docker turned on (or `--docker` is given), because the socket is root-equivalent.
- **Services** (`collectors.services`, up to 50): `systemd` (`systemctl show` for validated unit names only, `^[A-Za-z0-9@_.:-]+$`, never starting with `-`; the only program the agent ever runs), `process` (scans `/proc` comm and argv[0]), `port` (TCP connect, 3 s), `nginx` / `apache` (GET of the configured status URL, redirects not followed), and `redis` (`PING`), `mysql` (server greeting), `postgres` (SSLRequest) liveness probes without credentials. Every configured service is reported on every send.
- A settings document with a malformed service entry (unknown kind, bad name/host/URL/port, duplicates) is rejected as a whole and reported as `config_invalid`; the previous settings stay in force.
## Commands

| Command | What it does |
| --- | --- |
| `yuktiops-agent register --key=yk_live_... [--setup=st_...] [--api=URL] [--name=NAME]` | Exchanges the account API key for this server's own credential. Registering the same machine again reconnects it (no duplicate). The API key is used once and never stored. |
| `yuktiops-agent status` | Plain-language status: "Running, Connected, last data sent 12 seconds ago". Works without sudo. Exit code 0 only when healthy. |
| `sudo yuktiops-agent doctor` | Tests file permissions, DNS, proxy, HTTPS, the clock (against the server's `Date` header), the credential and the service. Prints how to fix each problem, with the same error codes as the dashboard. |
| `sudo yuktiops-agent uninstall [--keep-config]` | Stops and removes the service, binary, user, data and (unless `--keep-config`) settings. Package installs are removed through dpkg/rpm. |
| `yuktiops-agent version` | Version and build info. |
| `yuktiops-agent run` | The background process (started by systemd). |

Everyday commands:

```
yuktiops-agent status                     # friendly status
sudo systemctl restart yuktiops-agent     # restart
sudo journalctl -u yuktiops-agent -f      # live logs
sudo yuktiops-agent doctor                # diagnose problems
```

## Files

| Path | Owner / mode | Contents |
| --- | --- | --- |
| `/usr/local/bin/yuktiops-agent` | root 0755 | the program |
| `/etc/systemd/system/yuktiops-agent.service` | root 0644 | the service |
| `/etc/yuktiops/` | root:yuktiops 0750 | settings |
| `/etc/yuktiops/credential` | root:yuktiops 0640 | this server's own credential (never the account API key) |
| `/etc/yuktiops/agent.yaml` | root:yuktiops 0640 | settings (below) |
| `/etc/yuktiops/environment` | root:yuktiops 0640, optional | `HTTPS_PROXY=...`, `NO_PROXY=...` for the service |
| `/var/lib/yuktiops/` | yuktiops | offline buffer (`buffer.jsonl`), cached remote settings, `state.json` (read by `status`; no secrets) |

## Configuration file reference

`/etc/yuktiops/agent.yaml` is written by `register`. Edit it by hand if needed, then `sudo systemctl restart yuktiops-agent`. Unknown keys are ignored.

```yaml
# Where the agent sends data. HTTPS only (plain http is accepted for localhost, for development).
api_url: "https://api.yuktiops.com"

# The name this server was registered with, and its id in your account (informational).
name: "web-1"
agent_id: "0b8f8c4e-1111-2222-3333-444455556666"

# The setup profile chosen in the dashboard wizard (informational).
setup_id: "st_0123456789abcdef01234567"

# Optional outbound proxy. When it is not set, the HTTPS_PROXY / NO_PROXY environment variables are
# honoured (put them in /etc/yuktiops/environment for the service).
# proxy: "http://proxy.example.com:3128"
```

What is collected and how often (`sendIntervalSeconds`, `sampleIntervalSeconds`, and which built-in collectors are on) is managed from the dashboard. The agent pulls it when the version announced in a response changes.

Environment variables (for development and containers): `YUKTIOPS_CONFIG_DIR`, `YUKTIOPS_STATE_DIR`, `YUKTIOPS_API_URL`, `YUKTIOPS_API_KEY` (used by `register`, and by `run` to register itself on first start in a container), `YUKTIOPS_NAME`.

## Security model

- **Outbound only.** The agent opens no listening port. It talks to one host, over HTTPS; redirects are never followed, so the credential cannot leak to another host. Plain HTTP is refused except for `localhost`.
- **Never executes remote commands.** The only thing YuktiOps can change remotely is which built-in, read-only collectors run and how often. Settings are validated and clamped; invalid ones are ignored.
- **Least privilege.** It runs as the system user `yuktiops` with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only`, `PrivateTmp`, a restricted set of socket families, and hard memory and CPU caps. Docker access is opt-in (profile setting or `--docker`) because the Docker socket is root-equivalent.
- **Secrets.** The account API key is used once to register and is never written to disk. The server's own credential is stored `0640 root:yuktiops`, can be revoked from the dashboard, and only identifies this one server. Installers verify the SHA-256 of the download and abort on a mismatch.
- **Reliability.** Samples that cannot be sent are kept for up to 15 minutes (in memory, and on disk during an outage) and back-filled in order. Retries use exponential backoff with jitter.
- **Clock.** If the server's clock is wrong the backend corrects the timestamps; `doctor` tells you how to fix the clock.

## Uninstall

```
sudo yuktiops-agent uninstall            # remove everything
sudo yuktiops-agent uninstall --keep-config   # keep /etc/yuktiops
```

Then remove the server in the dashboard (Servers, choose the server, Remove). For a package install, `sudo apt remove yuktiops-agent` / `sudo rpm -e yuktiops-agent` also works.

## Build and test

```
npm run agent:test       # go vet + go test (-race) using local Go or the golang Docker image
npm run agent:build      # one binary for this machine -> agent/bin/
npm run agent:dist       # linux amd64, arm64, armv7 tarballs + checksums.txt + latest.json + install.sh -> backend/downloads/
```

With the API running (`npm run dev`), `backend/downloads/` is served at `http://localhost:4000/downloads/`:

```
curl -fsSL http://localhost:4000/downloads/install.sh | sudo bash -s -- \
  --base-url=http://localhost:4000/downloads --api=http://localhost:4000 --key=yk_live_...
```

Releases: pushing a tag like `agent/v0.4.1` runs `.github/workflows/agent-release.yml` (test, build with GoReleaser, upload to Cloudflare R2 and the GitHub release, smoke-test `install.sh` on a fresh Ubuntu runner, and only then update `latest.json`). Required GitHub secrets (names only): `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
