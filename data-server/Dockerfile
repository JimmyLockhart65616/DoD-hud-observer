# KTP Data Server — mirrors production data server topology
#
# Single container running all data server processes:
#   - 2 HLTV proxies (spectating + demo recording)
#   - HLStatsX stub (UDP log receiver, replace with real daemon later)
#   - MySQL (HLStatsX database)
#   - Node.js backend (HUD Observer ingest + REST API + Socket.IO)
#   - Static frontend (React build served via 'serve')
#
# Multi-stage build:
#   Stage 1 (hlds-source): extract HLTV binaries from jives/hlds:dod
#   Stage 2 (app-builder): install deps + build React frontend
#   Stage 3: Ubuntu with supervisord running all processes

# ---- Stage 1: HLTV binaries ----
FROM jives/hlds:dod AS hlds-source

# ---- Stage 2: Build Node.js application ----
FROM node:18-slim AS app-builder
WORKDIR /build

# Root deps (backend)
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

# Backend source
COPY backend/ ./backend/

# Web deps (separate layer for caching)
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci --legacy-peer-deps

# Web source + build
COPY web/ ./web/
# Origin-relative build (single-origin proxy deployments). We DON'T bake a
# REACT_APP_* origin: with none set, the bundle dials whatever origin it's served
# from (window.location.origin / relative /api) — see web/.../Socket.jsx. So this
# one image works behind nginx at https://localhost (local) OR https://hud.ktpdod.com
# (prod) with no rebuild and no baked hostname. `rm -f .env.local` is still
# required — CRA loads it in every mode and it's port-shifted to 3011/4010 for the
# host `npm run web` workflow, which would otherwise bake the wrong URLs here.
# (Prod via deploy/deploy.sh instead injects REACT_APP_*=https://hud.ktpdod.com
# inline to beat the developer's real .env.local without deleting it.)
RUN cd web && rm -f .env.local && npm run build

# Install 'serve' for static file serving
RUN npm install -g serve

# config last — changes more often than source, must not bust web/backend cache
COPY config/local/config.yaml ./config/local/config.yaml

# ---- Stage 3: Data server ----
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive

# System packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    supervisor \
    nginx \
    openssl \
    lib32gcc-s1 \
    lib32stdc++6 \
    lib32z1 \
    socat \
    mysql-server \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Single-origin reverse proxy — mirrors the production nginx vhost so the local
# stack serves the overlay + REST + Socket.IO from ONE origin (:80 in-container,
# published to the host as :8080). Drop the stock default site so our conf.d
# snippet is the only :80 server.
RUN rm -f /etc/nginx/sites-enabled/default
COPY data-server/nginx-hud.conf /etc/nginx/conf.d/hud.conf

# Node.js runtime (copied from builder, not installed via apt)
COPY --from=app-builder /usr/local/bin/node /usr/local/bin/node
COPY --from=app-builder /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && ln -sf /usr/local/lib/node_modules/serve/build/main.js /usr/local/bin/serve

# HLTV engine files (full hlds directory — HLTV needs engine libs + mod data)
COPY --from=hlds-source /opt/steam/hlds /opt/hltv

# Set up per-instance HLTV directories (each needs its own CWD for config + temp files)
# Symlink ALL binaries, .so files, and game dirs — HLTV loads many engine libs at runtime
RUN for i in 1 2; do \
        mkdir -p /opt/hltv/instance-$i/demos; \
        for f in /opt/hltv/*.so /opt/hltv/hltv; do \
            ln -sf "$f" /opt/hltv/instance-$i/$(basename "$f"); \
        done; \
        ln -sf /opt/hltv/dod /opt/hltv/instance-$i/dod; \
        ln -sf /opt/hltv/valve /opt/hltv/instance-$i/valve; \
    done

# Node.js application
COPY --from=app-builder /build /app

# MySQL init directory
RUN mkdir -p /var/run/mysqld && chown mysql:mysql /var/run/mysqld

# Supervisord config
COPY data-server/supervisord.conf /etc/supervisor/conf.d/data-server.conf

# Startup script (MySQL init + supervisord)
# Local hlstatsx schema + synthetic fixture, applied idempotently by start.sh on
# every boot. A MINIMAL LOCAL SUBSET, never the production schema.
#
# This lives in the image rather than a bind mount on purpose: KTPInfrastructure's
# docker-compose.local.yml builds this same Dockerfile with DoD-hud-observer as
# its context, so anyone who brings up EITHER stack gets a seeded database with
# no extra step, no credentials and no network access.
COPY data-server/sql/ /app/data-server/sql/

# Point the read-only stats layer at this container's own MySQL.
#
# Set here rather than in either compose file so both stacks inherit it: this
# repo's docker-compose.yml and KTPInfrastructure's docker-compose.local.yml
# (which mounts its OWN config/local/config.yaml over /app/config.yaml and would
# otherwise need a coordinated cross-repo edit just to switch a local feature on).
# Either compose can still override any of these with `environment:`.
#
# Production does NOT inherit this — it sets stats_db in its own
# config/online/config.yaml with a real SELECT-only user.
ENV HUD_STATSDB_ENABLED=true     HUD_STATSDB_HOST=127.0.0.1     HUD_STATSDB_PORT=3306     HUD_STATSDB_USER=hlstatsx     HUD_STATSDB_PASSWORD=ktptest     HUD_STATSDB_DATABASE=hlstatsx

COPY data-server/start.sh /start.sh
RUN chmod +x /start.sh

# Ports:
#   443   — nginx single-origin reverse proxy, TLS (overlay + /api + /socket.io)
#   80    — nginx :80→:443 redirect (mirrors prod certbot)
#   3000  — React frontend (static, direct — behind nginx in normal use)
#   3001  — REST API (direct — behind nginx in normal use)
#   4000  — Socket.IO (direct — behind nginx in normal use)
#   8088  — HTTP ingest from AMXX plugin (KTPAMXXCurl, NOT proxied)
#   27020 — HLTV proxy 1
#   27021 — HLTV proxy 2
#   27500 — HLStatsX log receiver (UDP)
#   3306  — MySQL
EXPOSE 443 80 3000 3001 4000 8088 27020 27021 27500 3306

CMD ["/start.sh"]
