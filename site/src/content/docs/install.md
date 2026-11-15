---
title: Install the agent
description: "Install the YuktiOps agent on Ubuntu, Debian, RHEL, Rocky, Amazon Linux or Docker."
group: Start here
order: 2
---

The agent is one small program with no dependencies. It runs in the background as its own user, `yuktiops`, and starts again after every reboot. Supported: Linux on x86-64 (amd64), ARM64 and ARMv7 (older Raspberry Pi). Windows and macOS are not available yet.

The dashboard's **Add server** page creates the exact commands for you. This page explains each option.

## One command (any Linux with systemd)

```
curl -fsSL https://get.yuktiops.com | sudo bash -s -- --key=yk_live_...
```

The script checks your machine, downloads the right build, verifies its checksum, installs the service, registers the server and waits for the first data. Running it again upgrades the agent. Useful options:

| Option | Meaning |
| --- | --- |
| `--name=web-1` | Name shown in the dashboard (default is the hostname) |
| `--docker` | Let the agent read Docker container stats (see the warning below) |
| `--version=0.4.1` | Install a specific version |
| `--no-start` | Install but do not start yet |

## Ubuntu and Debian (.deb package)

Download the `.deb` from the dashboard's **Download** tab, then:

```
sudo dpkg -i yuktiops-agent_<version>_amd64.deb
sudo yuktiops-agent register --key=yk_live_...
sudo systemctl enable --now yuktiops-agent
```

Use the `arm64` file on ARM machines. Remove later with `sudo apt remove yuktiops-agent`.

## RHEL, Rocky, Alma, CentOS and Amazon Linux (.rpm package)

```
sudo rpm -i yuktiops-agent-<version>.x86_64.rpm
sudo yuktiops-agent register --key=yk_live_...
sudo systemctl enable --now yuktiops-agent
```

Use the `aarch64` file on ARM machines. Remove later with `sudo rpm -e yuktiops-agent`.

## Other Linux (.tar.gz)

Use the one-command install, or unpack the `.tar.gz` yourself, put `yuktiops-agent` in `/usr/local/bin`, and register as above. The one-command installer also creates the service file for you.

## Docker

```
docker run -d --name yuktiops-agent --restart unless-stopped \
  -e YUKTIOPS_API_KEY=yk_live_... \
  -v yuktiops-agent:/var/lib/yuktiops \
  ghcr.io/yuktiops/agent
```

The container registers itself the first time it starts. It reports the container's own view of the system, so use the normal install if you want the host's numbers.

## Docker container monitoring (optional)

Reading Docker statistics needs access to the Docker socket. That access is powerful: on most systems it is as strong as root. The agent only reads container stats, but we turn this on only when you ask for it (`--docker`, or tick Containers in the wizard). Without it nothing is added to the `docker` group.

## Check and remove

```
yuktiops-agent status
sudo yuktiops-agent uninstall
```

See [Agent commands](/docs/agent-commands). The server also needs to be removed in the dashboard (Servers, choose the server, Remove).
