# KTP Game Server — Runtime Image
#
# Combines a SteamCMD-installed HLDS DoD 1.3 base with KTP build artifacts
# to produce a complete, runnable game server container.
#
# This mirrors production bare-metal topology:
#   LinuxGSM → SteamCMD installs HLDS app 90 (mod dod) →
#   deploy.py overlays KTP-ReHLDS + KTPAMXX + DODX + ReAPI + KTPAMXXCurl
#   No Metamod. Same binaries and same install path production uses.
#
# Prerequisites:
#   make build                  # compile all KTP components
#   make extract-artifacts      # extract to artifacts/VERSION/
#
# Usage (via Makefile):
#   make local-build            # build this runtime image
#   make local-up               # start game server(s)
#
# Or directly:
#   docker compose -f docker-compose.local.yml build
#   docker compose -f docker-compose.local.yml up -d

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# --- System dependencies ---
# 32-bit runtime libs needed by HLDS + SteamCMD to download the game data.
# Matches provision/provision-gameserver.sh line 271-296.
RUN dpkg --add-architecture i386 && \
    apt-get update && \
    echo "steamcmd steam/question select I AGREE" | debconf-set-selections && \
    echo "steamcmd steam/license note " | debconf-set-selections && \
    apt-get install -y --no-install-recommends \
        lib32gcc-s1 \
        lib32stdc++6 \
        lib32z1 \
        libc6-i386 \
        libssl3:i386 \
        libcurl4:i386 \
        ca-certificates \
        binutils \
        steamcmd \
    && rm -rf /var/lib/apt/lists/*

# --- HLDS DoD 1.3 install via SteamCMD ---
# App 90 is Half-Life Dedicated Server; `mod dod` selects the Day of Defeat mod.
# This is identical to what LinuxGSM runs during `./dodserver auto-install`.
# Installs to /opt/hlds producing the same layout as production Denver 5:
#   /opt/hlds/hlds_linux, /opt/hlds/dod/, /opt/hlds/valve/, Steam runtime .so files
RUN mkdir -p /opt/hlds /root/.steam && \
    /usr/games/steamcmd \
        +force_install_dir /opt/hlds \
        +login anonymous \
        +app_set_config 90 mod dod \
        +app_update 90 validate \
        +app_set_config 90 mod dod \
        +app_update 90 validate \
        +quit

# --- KTP Build Artifacts (overlay on top of stock HLDS) ---
# Engine (KTP-ReHLDS — replaces stock hlds_linux, engine_i486.so, libsteam_api.so)
ARG VERSION=latest
COPY artifacts/${VERSION}/engine/ /opt/hlds/

# KTPAMXX platform (loaded as ReHLDS extension, no Metamod)
COPY artifacts/${VERSION}/ktpamx/dlls/ /opt/hlds/dod/addons/ktpamx/dlls/
COPY artifacts/${VERSION}/ktpamx/modules/ /opt/hlds/dod/addons/ktpamx/modules/

# KTP application plugins
COPY artifacts/${VERSION}/plugins/ /opt/hlds/dod/addons/ktpamx/plugins/

# AMXX compiler + includes (for compiling custom plugins inside the container)
COPY artifacts/${VERSION}/ktpamx/scripting/ /opt/hlds/dod/addons/ktpamx/scripting/

# extensions.ini — tells KTP-ReHLDS to load KTPAMXX as an engine extension
RUN echo 'addons/ktpamx/dlls/ktpamx_i386.so' > /opt/hlds/dod/addons/extensions.ini

# KTPAMXX config and data directories.
# Listed individually — /bin/sh does not expand brace syntax.
# Must come AFTER all COPY statements so COPY can't remove them.
RUN mkdir -p \
    /opt/hlds/dod/addons/ktpamx/configs \
    /opt/hlds/dod/addons/ktpamx/data \
    /opt/hlds/dod/addons/ktpamx/logs

# Make KTP binaries executable
RUN chmod +x /opt/hlds/hlds_linux /opt/hlds/engine_i486.so /opt/hlds/libsteam_api.so && \
    chmod +x /opt/hlds/dod/addons/ktpamx/dlls/*.so && \
    chmod +x /opt/hlds/dod/addons/ktpamx/modules/*.so && \
    (chmod +x /opt/hlds/dod/addons/ktpamx/scripting/amxxpc 2>/dev/null || true)

# Entrypoint
COPY runtime/entrypoint.sh /entrypoint.sh
# Clean Windows line endings and make executable
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

WORKDIR /opt/hlds

EXPOSE 27015/udp
EXPOSE 27015/tcp
EXPOSE 26900/udp

ENTRYPOINT ["/entrypoint.sh"]
