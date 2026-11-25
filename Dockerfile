# syntax=docker/dockerfile:1
# Production image for YuktiOps. Targets:
#   runtime (default, last stage)  API + worker (same image, different command)
#   web                Caddy serving the built frontend and proxying /api, /v1 to the API
# Build:  docker build -t yuktiops-app:<tag> --target runtime .
#         docker build -t yuktiops-web:<tag> --target web .

ARG NODE_VERSION=22

# ---- backend dependencies + Prisma client -------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS backend-deps
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/package.json
COPY backend/package.json backend/package.json
# Only the backend workspace (and its deps, including the Prisma CLI needed for `migrate deploy`).
RUN npm ci -w backend --ignore-scripts && npm cache clean --force
COPY backend/prisma backend/prisma
RUN node node_modules/prisma/build/index.js generate --schema backend/prisma/schema.prisma

# ---- frontend build ---------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS frontend-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/package.json
COPY backend/package.json backend/package.json
RUN npm ci -w frontend --ignore-scripts
COPY frontend frontend
RUN npm run build -w frontend

# ---- docs / marketing site build (Astro) -----------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS site-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY site/package.json site/package.json
COPY frontend/package.json frontend/package.json
COPY backend/package.json backend/package.json
RUN npm ci -w site --ignore-scripts
COPY site site
RUN npm run build -w site

# ---- web: Caddy + static frontend -------------------------------------------------------------------
FROM caddy:2-alpine AS web
# Caddyfile = direct edge (80/443); Caddyfile.traefik = behind a TCP-passthrough proxy. Both import sites.caddy.
COPY deploy/Caddyfile deploy/Caddyfile.traefik deploy/sites.caddy /etc/caddy/
COPY --from=frontend-build /app/frontend/dist /srv/app
COPY --from=site-build /app/site/dist /srv/docs
EXPOSE 80 443

# ---- API / worker runtime ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=backend-deps --chown=root:root /app/node_modules node_modules
COPY --chown=root:root package.json package-lock.json ./
COPY --chown=root:root backend backend
# Code is owned by root and read-only to the runtime user; the app writes nothing to disk.
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "backend/src/server.js"]
