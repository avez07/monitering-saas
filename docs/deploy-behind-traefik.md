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

## 3. Traefik: one TCP router (file provider)
Traefik needs a TCP entrypoint on 443 that is not already bound to HTTP-only routers, or add this alongside them.
HTTP routers for your other domain keep working: Traefik picks the router by SNI.
```yaml
# /etc/traefik/dynamic/yuktiops.yml
tcp:
  routers:
    yuktiops:
      entryPoints: [websecure]
      rule: HostSNI(`app.yuktiops.com`) || HostSNI(`api.yuktiops.com`) || HostSNI(`doc.yuktiops.com`)
      tls:
        passthrough: true
      service: yuktiops-caddy
  services:
    yuktiops-caddy:
      loadBalancer:
        proxyProtocol:
          version: 2
        servers:
          - address: 'yuktiops-web-1:443'
```
`yuktiops-web-1` is the Caddy container name (`docker ps --format '{{.Names}}' | grep web`). Traefik must be
reloaded or watch the directory. Only these hostnames are passed through; everything else is unchanged.

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
