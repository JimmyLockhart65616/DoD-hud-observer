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
#   Stage 1  (hlds-source):     HLDS runtime tree (engine, gamedir, steam libs)
#   Stage 1b (steamapi-legacy): legacy libsteam_api.so KTPReHLDS HLTV links
#   Stage 1c (hltv-builder):    KTPReHLDS HLTV modules at the prod-pinned ref
#   Stage 2  (app-builder):     install deps + build React frontend
#   Stage 3: Ubuntu with supervisord running all processes

# ---- Stage 1: HLDS runtime tree ----
# Supplies everything EXCEPT the five HLTV binaries: engine_i486.so,
# filesystem_stdio.so, the steam/vgui/voice libs, and the dod gamedir. Those are
# byte-identical to production's HLTV host (verified 2026-07-30, 15 files).
FROM jives/hlds:dod AS hlds-source

# ---- Stage 1b: legacy libsteam_api.so ----
# KTPReHLDS HLTV's proxy.so links the legacy FLAT Steam accessors
# `SteamGameServer` and `SteamGameServer_Init`. The modern Steamworks build that
# jives/hlds:dod ships (375,272 bytes) dropped both, so proxy.so fails to load
# with NO diagnostic — ldd stays clean because the *library* resolves and only
# the *symbols* don't, and HLTV swallows the dlopen error. That failure is silent
# and cost a full debugging session; do not "simplify" this stage away.
#
# jives/hlds:valve-legacy carries the 76,032-byte legacy build,
# md5 cf904f9dd3ef111831747eccb73a1fd0 — byte-identical to production's copy.
FROM jives/hlds:valve-legacy AS steamapi-legacy

# ---- Stage 1c: KTPReHLDS HLTV ----
# Production runs HLTV built from KTPReHLDS, NOT the stock Valve HLTV that
# jives/hlds:dod ships. Before this stage the local stack ran Valve's build
# (3x the size, no rehlds strings), so every HLTV behaviour observed locally —
# broadcast clock, RunClocks sag, rate limits — was measured against the wrong
# engine.
#
# KTPREHLDS_REF pins the commit whose binaries production actually runs. This is
# NOT "latest main": cf5327c (2026-03-08) landed after production's 2026-02-26
# build and raises the HLTV rate constants 10-100x (m_UpdateRate 20 -> 200,
# m_Rate 10000 -> 1000000). Building from main would make the local proxy push
# frames ~10x more often than production. Bump this ONLY when production's HLTV
# is rebuilt, and re-verify against the real host.
#
# Parity evidence for bc30884 (built with prod's GCC 13.3 on Ubuntu 24.04):
# .data and .bss match production byte-for-byte on all five binaries; .text is
# within 0.1%, attributable to the compiler point release. We build on 22.04
# here to match this image's glibc 2.35 runtime — a 24.04 build needs
# GLIBC_2.38 and will not start. Source parity is what matters for timing
# fidelity; the codegen delta is a compiler patch version.
FROM ubuntu:22.04 AS hltv-builder
ARG KTPREHLDS_REPO=https://github.com/afraznein/KTP-ReHLDS.git
ARG KTPREHLDS_REF=bc30884
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential gcc-multilib g++-multilib cmake git dos2unix ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone "$KTPREHLDS_REPO" /src \
    && cd /src \
    && git checkout -f "$KTPREHLDS_REF"
# appversion.sh is invoked by the Console target and must be LF + executable;
# a CRLF shebang fails as exit 127 ("command not found") and takes out `hltv`.
RUN find /src -name "*.sh" -exec dos2unix -q {} \; -exec chmod +x {} \;
RUN mkdir -p /b && cd /b \
    && cmake /src/rehlds/HLTV \
    && make -j"$(nproc)" core proxy demoplayer director hltv
RUN mkdir -p /out \
    && find /b -type f \( -name "*.so" -o -name hltv \) -exec cp {} /out/ \; \
    && ls -l /out

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

# Overlay the production HLTV stack on top of the stock tree. Order matters:
# these must land BEFORE the instance-dir symlink loop below, which links
# whatever /opt/hltv/*.so happens to exist at that point (director.so has no
# Valve counterpart and only appears here).
COPY --from=hltv-builder /out/ /opt/hltv/
COPY --from=steamapi-legacy /opt/steam/hlds/libsteam_api.so /opt/hltv/libsteam_api.so
RUN chmod +x /opt/hltv/hltv /opt/hltv/*.so

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

# HLTV needs a live stdin or its console never dispatches rcon commands (see the
# wrapper's header). Production launches it the same way.
COPY data-server/hltv-wrapper.sh /opt/hltv/hltv-wrapper.sh
RUN chmod +x /opt/hltv/hltv-wrapper.sh

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
