---
title: Agent commands
description: "The yuktiops-agent commands: status, doctor, uninstall, register and version, plus everyday systemd commands."
group: Start here
order: 3
---

## Everyday commands

```
yuktiops-agent status                     # friendly status
sudo systemctl restart yuktiops-agent     # restart
sudo journalctl -u yuktiops-agent -f      # live logs
sudo yuktiops-agent doctor                # diagnose problems
sudo yuktiops-agent uninstall             # remove completely
```

## status

Prints one plain-language line, for example "Running, Connected, last data sent 12 seconds ago". It works without `sudo`. It exits with code 0 only when everything is healthy, so you can use it in scripts.

## doctor

Run this first when something is wrong. It tests, in order: file permissions, DNS, proxy, HTTPS, the server clock, the server's credential and the background service. For each problem it prints what is wrong and how to fix it, using the same wording as the dashboard.

```
sudo yuktiops-agent doctor
```

## register

Used by the installer. It exchanges your account API key for this server's own credential. Registering the same machine twice reconnects it and does not create a duplicate. The API key is used once and is not stored.

```
sudo yuktiops-agent register --key=yk_live_... [--name=web-1]
```

## uninstall

Stops and removes the service, the program, the `yuktiops` user, its data and its settings.

```
sudo yuktiops-agent uninstall                # remove everything
sudo yuktiops-agent uninstall --keep-config  # keep /etc/yuktiops
```

Afterwards, remove the server in the dashboard as well.

## version

```
yuktiops-agent version
```

## run

The background process that systemd starts. You never need to type it.
