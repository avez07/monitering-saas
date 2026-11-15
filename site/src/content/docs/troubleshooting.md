---
title: Troubleshooting
description: "Fix the most common YuktiOps problems in plain language: no data, firewall, clock, plan limit, revoked key, Docker."
group: Troubleshooting
order: 9
---

Start with the doctor. On the server:

```
sudo yuktiops-agent doctor
```

It tests everything and prints the fix in plain English. The dashboard's **Connection** tab for each server shows the same messages.

## Pick your problem

- [No data is arriving](/docs/troubleshooting-no-data)
- [Firewall, proxy or DNS blocks the agent](/docs/troubleshooting-firewall-proxy)
- [The server clock is wrong](/docs/troubleshooting-clock-skew)
- [You reached your plan limit](/docs/troubleshooting-plan-limit)
- [The server was disconnected (revoked key)](/docs/troubleshooting-revoked-key)
- [The agent cannot read Docker](/docs/troubleshooting-docker-permission)

## Useful commands

```
yuktiops-agent status
sudo systemctl status yuktiops-agent
sudo systemctl restart yuktiops-agent
sudo journalctl -u yuktiops-agent -n 100
```
