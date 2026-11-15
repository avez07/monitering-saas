---
title: Firewall, proxy or DNS
description: "Allow the YuktiOps agent through your firewall, proxy and DNS settings."
group: Troubleshooting
order: 11
---

**Your server can't reach YuktiOps over HTTPS.** The agent needs to open a connection to `api.yuktiops.com` on port 443. It never needs an incoming port.

## Firewall or cloud security group

Allow **outbound** HTTPS (TCP port 443) to `api.yuktiops.com`. Most servers allow this by default, but some strict firewalls and cloud security groups do not.

Test it:

```
curl -I https://api.yuktiops.com/api/health
```

A reply that starts with `HTTP/` means it works.

## DNS

If the name cannot be looked up, your server has no working DNS resolver.

```
getent hosts api.yuktiops.com
cat /etc/resolv.conf
```

## Proxy

If your network requires a proxy, tell the agent about it. Add to `/etc/yuktiops/environment`:

```
HTTPS_PROXY=http://proxy.example.com:3128
```

Then restart:

```
sudo systemctl restart yuktiops-agent
```

Test through the proxy: `curl -I -x "$HTTPS_PROXY" https://api.yuktiops.com/api/health`

## TLS errors

"The secure connection could not be set up" usually means a wrong clock, missing certificates, or a proxy that re-signs traffic.

```
sudo timedatectl set-ntp true
sudo update-ca-certificates
```

Finish with `sudo yuktiops-agent doctor`.
