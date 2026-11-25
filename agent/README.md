# YuktiOps agent

A small program that watches a Linux machine (CPU, memory, disks, network, processes) and sends the numbers to YuktiOps over outbound HTTPS. It opens no ports.

## Quick start

Get your API key (`yk_live_...`) from the YuktiOps dashboard: Servers, Add a server.

**One command (Linux, easiest)**

```
curl -fsSL https://get.yuktiops.com | sudo bash -s -- --key=yk_live_...
```

**.deb (Debian, Ubuntu)** and **.rpm (Fedora, RHEL, Rocky)**: download from the dashboard's Download tab, then:

```
sudo dpkg -i yuktiops-agent_<version>_amd64.deb     # rpm: sudo rpm -i yuktiops-agent-<version>.x86_64.rpm
sudo yuktiops-agent register --key=yk_live_...
sudo systemctl enable --now yuktiops-agent
```

**Tarball** (other Linux, no package manager): download `yuktiops-agent_<version>_linux_<arch>.tar.gz` from the Download tab, then:

```
tar xzf yuktiops-agent_<version>_linux_<arch>.tar.gz
sudo install -m 0755 yuktiops-agent /usr/local/bin/yuktiops-agent
sudo cp yuktiops-agent.service /etc/systemd/system/    # needs the yuktiops user: sudo useradd --system --no-create-home yuktiops
sudo yuktiops-agent register --key=yk_live_...
sudo systemctl daemon-reload && sudo systemctl enable --now yuktiops-agent
```

**Docker on a Linux server**

```
docker run -d --name yuktiops-agent --restart unless-stopped \
  --pid host --network host -v /:/host:ro -e HOST_ROOT=/host \
  -v /var/run/docker.sock:/var/run/docker.sock:ro --group-add $(stat -c '%g' /var/run/docker.sock) \
  -e YUKTIOPS_API_KEY=yk_live_... -v yuktiops-agent:/var/lib/yuktiops \
  yuktiops/yuktiops-agent
```

The `--pid host`, `--network host`, `-v /:/host:ro` and `HOST_ROOT` parts make the agent report the server itself. Without them it only sees its own container, and the advanced (node_exporter) metrics describe the container instead of the host. Container stats, cAdvisor metrics and container logs all need the `docker.sock` mount. Leave out the `docker.sock` and `--group-add` lines if you do not want container stats. The agent in the container is not root and the socket belongs to root, so `--group-add 0` is needed on Docker Desktop (Windows, Mac). On a Linux server use `--group-add $(stat -c '%g' /var/run/docker.sock)` instead (the socket's group is usually `docker`). Without it the agent runs but no containers appear.

**Image says `denied` / `pull access denied`?** The Docker Hub repository is private or the tag is not published yet. Either `docker login`, or build it yourself from this repository (works offline from the registry):

bash / Git Bash / macOS (repo root):

```
docker build -t yuktiops-agent:local -f agent/Dockerfile agent
docker run -d --name yuktiops-agent --restart unless-stopped   --pid host --network host -v /:/host:ro -e HOST_ROOT=/host   -v /var/run/docker.sock:/var/run/docker.sock:ro --group-add 0   -e YUKTIOPS_API_KEY=yk_live_... -e YUKTIOPS_API_URL=http://localhost:4000   -v yuktiops-agent:/var/lib/yuktiops yuktiops-agent:local
```

PowerShell (repo root):

```
docker build -t yuktiops-agent:local -f agent/Dockerfile agent
docker run -d --name yuktiops-agent --restart unless-stopped `
  --pid host --network host -v /:/host:ro -e HOST_ROOT=/host `
  -v /var/run/docker.sock:/var/run/docker.sock:ro --group-add 0 `
  -e YUKTIOPS_API_KEY=yk_live_... -e YUKTIOPS_API_URL=http://localhost:4000 `
  -v yuktiops-agent:/var/lib/yuktiops yuktiops-agent:local
```

Or with compose: `YUKTIOPS_API_KEY=yk_live_... docker compose --profile agent up -d --build` (PowerShell: `$env:YUKTIOPS_API_KEY='yk_live_...'; docker compose --profile agent up -d --build`). Set `YUKTIOPS_AGENT_IMAGE` to use another image name.

**Publishing the image (maintainers).** Build and push with `docker buildx build --platform linux/amd64,linux/arm64 -t yuktiops/yuktiops-agent:<version> -t yuktiops/yuktiops-agent:latest -f agent/Dockerfile --build-arg VERSION=<version> --push agent`. Keep the Docker Hub repository public. Verify from a logged-out machine: `docker logout && docker pull yuktiops/yuktiops-agent:latest`.

**Docker Desktop on Windows or Mac.** Important: here the agent monitors Docker's Linux VM and your containers, **not** the Windows or Mac computer itself. Use the same command (`/host` is then the VM).

PowerShell:

```
docker run -d --name yuktiops-agent --restart unless-stopped `
  --pid host --network host -v /:/host:ro -e HOST_ROOT=/host `
  -v /var/run/docker.sock:/var/run/docker.sock:ro --group-add 0 `
  -e YUKTIOPS_API_KEY=yk_live_... -v yuktiops-agent:/var/lib/yuktiops `
  yuktiops/yuktiops-agent
```

Git Bash on Windows rewrites paths like `/var/run/docker.sock` into `C:\Program Files\Git\...` (the error is `mkdir C:\Program Files\Git\var: Access is denied`). Put `MSYS_NO_PATHCONV=1` in front of the command:

```
MSYS_NO_PATHCONV=1 docker run -d --name yuktiops-agent --restart unless-stopped \
  --pid host --network host -v /:/host:ro -e HOST_ROOT=/host \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -e YUKTIOPS_API_KEY=yk_live_... -v yuktiops-agent:/var/lib/yuktiops \
  yuktiops/yuktiops-agent
```

**Local development against an API on your own computer (Docker Desktop on Windows or Mac)**

Inside a container, `localhost` is **not** your computer. On Docker Desktop it is the container itself, or with `--network host` Docker's Linux VM. Reach the API on your computer through `host.docker.internal`. The agent only accepts plain `http://` for the names `localhost`, `127.0.0.1` and `::1`, so any other http address needs an explicit opt-in, `YUKTIOPS_ALLOW_INSECURE=true`. Leave it off in production: HTTPS stays required by default.

PowerShell (after `docker build -t yuktiops/yuktiops-agent:0.0.0-dev -f agent/Dockerfile agent`):

```
docker run -d --name yuktiops-agent --restart unless-stopped `
  --pid host -v /:/host:ro -e HOST_ROOT=/host `
  -e YUKTIOPS_API_KEY=yk_live_... `
  -e YUKTIOPS_API_URL=http://host.docker.internal:4000 `
  -e YUKTIOPS_ALLOW_INSECURE=true `
  -v yuktiops-agent:/var/lib/yuktiops `
  -v /var/run/docker.sock:/var/run/docker.sock:ro --group-add 0 `
  yuktiops/yuktiops-agent:0.0.0-dev
```

`--network host` is left out on purpose: with it, `host.docker.internal` may not resolve and the agent would report the VM's network instead. Add it back only if you need the VM's network counters and `docker exec yuktiops-agent yuktiops-agent doctor` still passes.

If it still fails, read the message. It names the URL, scheme, host, port, the address that was dialed and the reason (`connection refused`, `timed out`, `DNS failure`, a certificate or TLS error), for example:

```
This server cannot reach http://localhost:4000 (scheme http, host localhost, port 4000, resolved 127.0.0.1:4000): connection refused (nothing is listening at that address and port). Note: inside a container, localhost is the container itself ...
Error code: https_unreachable
```

The code name `https_unreachable` is kept for the dashboard's error catalog; it also covers plain-http connection failures. Run the full diagnosis inside the container with `docker exec yuktiops-agent yuktiops-agent doctor`. Check the API itself from Windows with `curl http://localhost:4000/api/health`; the API must listen on all interfaces, not only 127.0.0.1 inside WSL.

**Check that it works**

```
yuktiops-agent status                        # installed on the machine
docker exec yuktiops-agent yuktiops-agent status   # Docker install
sudo yuktiops-agent doctor                   # explains any problem and how to fix it
```

`status` should say "Running, Connected, last data sent ... ago". The server appears in the dashboard within a minute.

**Uninstall**

```
sudo yuktiops-agent uninstall        # or: sudo apt remove yuktiops-agent / sudo rpm -e yuktiops-agent
docker rm -f yuktiops-agent && docker volume rm yuktiops-agent    # Docker install
```

Then remove the server in the dashboard (Servers, choose the server, Remove).

---

## About the agent

- A single static Go binary, no dependencies, about 30 MB (it embeds the node_exporter collectors). Linux amd64, arm64 and armv7. Runs as the unprivileged user `yuktiops` under systemd (`Restart=always`, starts on boot).
- Collects CPU, memory, swap, disk per mount, disk I/O, network per interface, load, uptime and the top 10 processes, every 30 seconds by default.
- Target: under 25 MB RAM and 1% CPU. systemd enforces hard caps (`MemoryMax=64M`, `CPUQuota=10%`).

### Install script options

`--version=`, `--name=`, `--docker` (let the agent read Docker stats), `--no-start`, `--base-url=`, `--api=`, `--uninstall`. The script verifies the download's SHA-256 (and the cosign signature when `cosign` is installed). Running it again upgrades in place.

### Running in a container (`HOST_ROOT`)

A container normally sees only itself. With `HOST_ROOT=/host` and the host's `/` mounted read-only at `/host`, the agent reads `/host/proc`, `/host/sys` and `/host/etc` (OS name, machine id) and reports disk usage of the mounts found under `/host`, so it reports the host. `--pid host` and `--network host` give it the host's process list and network counters. When `HOST_ROOT` is unset nothing changes. `yuktiops-agent doctor` warns "running in a container without host mounts: you will only see the container" when it detects a container without these mounts.

## Reference

### Containers and services (opt-in, read-only)

Switched on from the setup profile in the dashboard (`collectors.docker`, `collectors.services`); nothing is collected until then. Both run in their own goroutine on the send interval, so a slow Docker daemon or a hanging port never delays sampling or sending.

- **Docker** (`collectors.docker`): GET-only calls over `/var/run/docker.sock` (container list, inspect, one-shot stats; no SDK, other HTTP methods are refused in code). Reports state, restart count, CPU % (from counter deltas between two collections, so the first value appears one interval after start), memory without page cache, memory limit and OOM flag. At most 100 containers, 4 requests at a time, 20 s overall timeout. If the socket is not readable it reports `docker_socket_denied` (once an hour at most) and keeps running. The installer adds the `yuktiops` user to group `docker` only when the profile has Docker turned on (or `--docker` is given), because the socket is root-equivalent.
- **Services** (`collectors.services`, up to 50): `systemd` (`systemctl show` for validated unit names only, `^[A-Za-z0-9@_.:-]+$`, never starting with `-`; the only program the agent ever runs), `process` (scans `/proc` comm and argv[0]), `port` (TCP connect, 3 s), `nginx` / `apache` (GET of the configured status URL, redirects not followed), and `redis` (`PING`), `mysql` (server greeting), `postgres` (SSLRequest), `mssql` (TDS PRELOGIN, default port 1433) liveness probes without credentials. A database service with a `credentialsRef` also logs in (see Database credentials below). Every configured service is reported on every send.
- **Container logs** (`collectors.containerLogs`, all plans, counts against the telemetry quota): follows the logs of running containers over the Docker socket (GET only), `include` / `exclude` by container name, and the Docker label `yuktiops.logs=false` opts a container out. Lines are sent as OTLP/HTTP JSON (gzip, up to 1 MB or every 2 s) to `/v1/otlp/logs` with the agent credential. At most 1000 lines per second per container; the last delivered timestamp per container is kept in the state directory, so a restart neither loses nor repeats lines. A `429` (quota used up) pauses logs only, for 5 minutes (`logs_quota`).

### Advanced metrics (premium plans, Linux only)

When the plan includes them (`collectors.prometheus`, set by YuktiOps from the plan, not by users), the agent sends Prometheus remote_write (protobuf + snappy) to `prometheus.path` (default `/v1/prom/write`) every `scrapeIntervalSeconds` (15 to 60, default 15):

- **Node metrics**: the standard node_exporter metric names (`job="node"`), read from `HOST_ROOT` when set.
- **Container metrics**: cAdvisor names (`container_*`, `job="cadvisor"`, label `name`) from the Docker socket, only when `collectors.docker` is on.
- **Database metrics**: exporter-compatible names (`redis_*`, `mysql_global_status_*`, `pg_*`, `mssql_*`) for services with credentials.

Plan changes switch it on or off without a restart (log line `Advanced metrics on (plan <name>)` / `Advanced metrics off`); a `402` from the API also turns it off. Unsent batches are queued (bounded, oldest dropped first) and retried with backoff.

### Database credentials (stay on the server)

A service entry only names a `credentialsRef` (for example `redis-main`); the secret is never sent to YuktiOps. The agent looks, in order, for:

1. Environment variables `YUKTIOPS_CRED_<REF>_URL`, or `YUKTIOPS_CRED_<REF>_USER` with `_PASSWORD` (optional `_DATABASE`, `_SSLMODE`). `<REF>` is upper-cased with `-` turned into `_`: `redis-main` -> `YUKTIOPS_CRED_REDIS_MAIN_PASSWORD`. For systemd installs put them in `/etc/yuktiops/environment`; for Docker pass them with `-e`.
2. The file `<configDir>/credentials.d/<ref>.env` (`/etc/yuktiops/credentials.d/redis-main.env`) with lines `URL=`, `USER=`, `PASSWORD=`, `DATABASE=`, `SSLMODE=`. In the Docker image the config dir is `/var/lib/yuktiops/config`. The file must be mode `0600` and owned by the agent's user (`yuktiops`; UID 65532 in the image), otherwise the service detail says `credentials file must be 0600`.

Use a least-privilege user, for example Postgres `GRANT pg_monitor`, MySQL `GRANT PROCESS, REPLICATION CLIENT`, MSSQL `GRANT VIEW SERVER STATE` (the dashboard shows the exact commands).
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
| `/etc/yuktiops/environment` | root:yuktiops 0640, optional | `HTTPS_PROXY=...`, `NO_PROXY=...`, `YUKTIOPS_CRED_*` for the service |
| `/etc/yuktiops/credentials.d/<ref>.env` | yuktiops 0600, optional | database credentials for a service's `credentialsRef` |
| `/var/lib/yuktiops/` | yuktiops | offline buffer (`buffer.jsonl`), cached remote settings, container log checkpoints, `state.json` (read by `status`; no secrets) |

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

Environment variables (for development and containers): `HOST_ROOT` (see below), `YUKTIOPS_CONFIG_DIR`, `YUKTIOPS_STATE_DIR`, `YUKTIOPS_API_URL`, `YUKTIOPS_ALLOW_INSECURE` (development only: allow plain `http://` to any host), `YUKTIOPS_API_KEY` (used by `register`, and by `run` to register itself on first start in a container), `YUKTIOPS_NAME`, `YUKTIOPS_CRED_<REF>_*` (database credentials, above).

## Security model

- **Outbound only.** The agent opens no listening port. It talks to one host, over HTTPS; redirects are never followed, so the credential cannot leak to another host. Plain HTTP is refused except for `localhost` (or any host when `YUKTIOPS_ALLOW_INSECURE=true`, for development).
- **Never executes remote commands.** The only thing YuktiOps can change remotely is which built-in, read-only collectors run and how often. Settings are validated and clamped; invalid ones are ignored.
- **Least privilege.** It runs as the system user `yuktiops` with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only`, `PrivateTmp`, a restricted set of socket families, and hard memory and CPU caps. Docker access is opt-in (profile setting or `--docker`) because the Docker socket is root-equivalent.
- **Secrets.** The account API key is used once to register and is never written to disk. The server's own credential is stored `0640 root:yuktiops`, can be revoked from the dashboard, and only identifies this one server. Installers verify the SHA-256 of the download and abort on a mismatch.
- **Reliability.** Samples that cannot be sent are kept for up to 15 minutes (in memory, and on disk during an outage) and back-filled in order. Retries use exponential backoff with jitter.
- **Clock.** If the server's clock is wrong the backend corrects the timestamps; `doctor` tells you how to fix the clock.

## Uninstall (details)

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
