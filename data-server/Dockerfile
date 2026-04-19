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
COPY config.yaml ./

# Web deps (separate layer for caching)
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci --legacy-peer-deps

# Web source + build
COPY web/ ./web/
RUN cd web && npm run build

# Install 'serve' for static file serving
RUN npm install -g serve

# ---- Stage 3: Data server ----
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive

# System packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    supervisor \
    lib32gcc-s1 \
    lib32stdc++6 \
    lib32z1 \
    socat \
    mysql-server \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

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
#   3000  — React frontend (static)
#   3001  — REST API
#   4000  — Socket.IO (backend <-> frontend)
#   8088  — HTTP ingest from AMXX plugin (KTPAMXXCurl)
#   27020 — HLTV proxy 1
#   27021 — HLTV proxy 2
#   27500 — HLStatsX log receiver (UDP)
#   3306  — MySQL
EXPOSE 3000 3001 4000 8088 27020 27021 27500 3306

CMD ["/start.sh"]
