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
# CRA picks up web/.env.local during build, which on this repo is intentionally
# port-shifted to 3011/4010 for the host-side `npm run web` dev workflow. That
# same .env.local would silently override .env.production inside the container
# and bake the wrong URLs into the bundle. Pass the docker-stack ports inline
# so the resulting bundle calls the host:3001 / host:4000 the data container
# actually exposes. Production overrides come from build-arg / CI env.
# Single-origin, byte-identical to prod: the bundle talks to the in-container
# nginx reverse proxy at https://hud.ktpdod.com (:443, published to the host as
# :80/:443), NOT the raw :3001/:4000 ports. nginx fans out /api, /socket.io, and
# / to the app processes; reach it by pointing hud.ktpdod.com at 127.0.0.1 in
# your hosts file. Same origin string as the prod deploy (deploy/deploy.sh), so
# this image IS the prod frontend artifact. Override via build-arg if needed.
ARG REACT_APP_API_URL=https://hud.ktpdod.com
ARG REACT_APP_SOCKET_URL=https://hud.ktpdod.com
RUN cd web && rm -f .env.local && \
    REACT_APP_API_URL=$REACT_APP_API_URL \
    REACT_APP_SOCKET_URL=$REACT_APP_SOCKET_URL \
    npm run build

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
