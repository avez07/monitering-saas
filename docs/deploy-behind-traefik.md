# Deploy YuktiOps behind an existing Traefik (SNI passthrough)

Traefik keeps ports 80/443 for your other domain and its paid certificate. For these three hostnames it only
forwards the encrypted TCP stream to Caddy. Caddy is the gateway: it gets its own Let's Encrypt certificates
(TLS-ALPN-01 over 443, so port 80 is not needed) and routes to the dashboard, API and docs.

| Host | Served by |
| --- | --- |
| `app.yuktiops.com` | dashboard (static) + `/api`, `/v1` to the API |
| `api.yuktiops.com` | agent endpoint and health checks |
| `doc.yuktiops.com` | docs / marketing site (static) |

## 1. DNS
Point `app`, `api` and `doc` A records (`yuktiops.com`) at the server's public IP. If you use Cloudflare, set them
to **DNS only** (grey cloud): passthrough and TLS-ALPN-01 do not work through the orange-cloud proxy.

## 2. Find Traefik's network
```bash
docker network ls                       # the network Traefik is on, e.g. traefik / proxy
docker network inspect traefik -f '{{(index .IPAM.Config 0).Subnet}}'
```
Put the name in `TRAEFIK_NETWORK` and the subnet in `PROXY_ALLOW` in `.env.production`.

## 3. Traefik: nothing to edit when the Docker provider is on
`docker-compose.traefik.yml` puts labels on the Caddy container that declare one TCP router (SNI passthrough
with PROXY protocol v2). Traefik discovers it when it runs with `--providers.docker=true` and shares the
`TRAEFIK_NETWORK` network. Your other routers, certificates and files are not changed.
If your 443 entrypoint is not called `websecure`, set `TRAEFIK_ENTRYPOINT` in `.env.production`.

Without the Docker provider, declare the same thing in Traefik's file provider: a `tcp.routers` entry with
`HostSNI(...)`, `tls.passthrough: true`, and a `tcp.services` entry pointing at `yuktiops-web-1:443` with
`proxyProtocol.version: 2`.

## 4. Environment and start
```bash
cd /opt/yuktiops
cp .env.production.example .env.production   # fill CHANGE_ME values, APP/API/DOCS_DOMAIN, ACME_EMAIL
docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml --env-file .env.production up -d --build
```

## 5. Check
```bash
docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml logs web | grep -i "certificate obtained"
curl -I https://api.yuktiops.com/api/health
curl -I https://doc.yuktiops.com/
curl -I https://app.yuktiops.com/
```
If certificates fail, the usual causes are the grey-cloud DNS setting, a wrong `PROXY_ALLOW` subnet (Caddy then
rejects Traefik's PROXY header) or the TCP router not matching the SNI.
