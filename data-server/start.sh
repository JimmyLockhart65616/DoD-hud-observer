#!/bin/bash
# KTP Data Server startup script
# Initializes MySQL on first run, then starts supervisord

set -e

# ============================================
# MySQL initialization + hlstatsx seeding
# ============================================
# Two separate concerns, deliberately not sharing a gate:
#
#   1. `mysqld --initialize-insecure` is genuinely first-run-only — it needs an
#      empty data directory.
#   2. Creating the hlstatsx database, its user, the schema and the fixture is
#      IDEMPOTENT and runs on EVERY boot.
#
# They used to share the first-run gate, which was a real bug: the `mysql-data`
# volume outlives `docker compose down`, so on any subsequent `up` the whole
# block was skipped and the hlstatsx database was never created at all. The
# stats endpoints then answered 503 forever on a stack that looked healthy, and
# the only clue was an "Unknown database" error nobody was reading.
if [ ! -d "/var/lib/mysql/mysql" ]; then
    echo "[data-server] First run — initializing MySQL data directory..."
    mysqld --initialize-insecure --user=mysql 2>&1
fi

# Bring MySQL up briefly so we can create/seed, then shut it down and let
# supervisord own it for the rest of the container's life.
mysqld --user=mysql &
MYSQL_PID=$!
for i in $(seq 1 60); do
    if mysqladmin ping --silent 2>/dev/null; then break; fi
    sleep 1
done

if mysqladmin ping --silent 2>/dev/null; then
    # The backend connects as this user. SELECT-only on purpose: this database is
    # written exclusively by the HLStatsX Perl daemon in production, and the HUD
    # backend has no business writing to it in any environment. Granting more
    # locally would let a mistake pass here and fail in prod.
    mysql -u root <<-EOF
        CREATE DATABASE IF NOT EXISTS hlstatsx;
        CREATE USER IF NOT EXISTS 'hlstatsx'@'localhost' IDENTIFIED BY 'ktptest';
        CREATE USER IF NOT EXISTS 'hlstatsx'@'127.0.0.1' IDENTIFIED BY 'ktptest';
        GRANT SELECT ON hlstatsx.* TO 'hlstatsx'@'localhost';
        GRANT SELECT ON hlstatsx.* TO 'hlstatsx'@'127.0.0.1';
        FLUSH PRIVILEGES;
EOF

    # Schema then fixture, in filename order. Both are idempotent
    # (CREATE TABLE IF NOT EXISTS / INSERT IGNORE), so this is safe every boot
    # and picks up a newly added file without needing the volume wiped.
    #
    # This is a MINIMAL LOCAL SUBSET, not the production schema — see
    # data-server/sql/01-schema.sql. Production is owned by KTPHLStatsX's own
    # numbered migrations and must never be pointed at these files.
    if [ -d /app/data-server/sql ]; then
        for f in /app/data-server/sql/*.sql; do
            [ -f "$f" ] || continue
            echo "[data-server] applying $(basename "$f")"
            if ! mysql -u root hlstatsx < "$f"; then
                # Non-fatal: a broken fixture must not stop the broadcast
                # overlay from starting. The stats routes degrade to 503.
                echo "[data-server] WARNING: $(basename "$f") failed — /api/stats/* will be incomplete"
            fi
        done
        echo "[data-server] hlstatsx ready: $(mysql -N -u root hlstatsx -e 'SELECT COUNT(*) FROM ktp_match_stats' 2>/dev/null || echo '?') match-stat rows"
    fi

    mysqladmin shutdown
    wait $MYSQL_PID 2>/dev/null || true
else
    echo "[data-server] WARNING: MySQL did not come up — skipping hlstatsx seeding"
    kill $MYSQL_PID 2>/dev/null || true
fi

# ============================================
# HLTV config setup
# ============================================
# Remove default hltv.cfg if present (avoid conflicts with instance configs)
rm -f /opt/hltv/hltv.cfg

# Copy staged HLTV configs from /host-cfgs/ into per-instance dirs.
# Direct bind-mount of cfgs into /opt/hltv/instance-N/hltv.cfg breaks the
# 32-bit HLTV binary's stat() on Docker Desktop / WSL2: the bind-mount
# synthesizes 64-bit inodes that overflow stat32 (EOVERFLOW), the cfg
# silently falls back to default port 27020, and both proxies race for
# the same port. KTPInfrastructure/docker-compose.local.yml stages the
# cfgs at /host-cfgs/ instead; this loop copies them to the instance dirs.
for i in 1 2; do
    if [ -f "/host-cfgs/hltv-$i.cfg" ]; then
        cp "/host-cfgs/hltv-$i.cfg" "/opt/hltv/instance-$i/hltv.cfg"
    fi
done

# Ensure demo directories exist
mkdir -p /opt/hltv/instance-1/demos /opt/hltv/instance-2/demos

# ============================================
# TLS cert for the nginx single-origin proxy
# ============================================
# nginx serves https://hud.ktpdod.com on :443 reading its cert from $CERT_DIR (a
# WRITABLE in-image dir). Preferred cert = a mkcert cert bind-mounted READ-ONLY at
# $CERT_SRC (locally trusted → green padlock in browser + OBS); copy it into
# $CERT_DIR. If none is mounted, self-sign into $CERT_DIR so nginx still starts
# and the :443/wss path is exercisable (browser warns until you drop in mkcert).
# The read-only mount / writable-read split lets the fallback write without
# hitting the mount's EROFS. Mirrors prod, where certbot supplies the cert.
CERT_DIR=/etc/nginx/certs
CERT_SRC=/etc/nginx/certs-src
mkdir -p "$CERT_DIR"
if [ -f "$CERT_SRC/hud.ktpdod.com.pem" ] && [ -f "$CERT_SRC/hud.ktpdod.com-key.pem" ]; then
    echo "[data-server] Using mounted TLS cert from $CERT_SRC (trusted if mkcert)"
    cp "$CERT_SRC/hud.ktpdod.com.pem" "$CERT_SRC/hud.ktpdod.com-key.pem" "$CERT_DIR/"
else
    echo "[data-server] No mounted TLS cert — self-signing a fallback (mount a mkcert cert for a trusted padlock)"
    openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
        -keyout "$CERT_DIR/hud.ktpdod.com-key.pem" \
        -out    "$CERT_DIR/hud.ktpdod.com.pem" \
        -subj "/CN=hud.ktpdod.com" \
        -addext "subjectAltName=DNS:hud.ktpdod.com,DNS:localhost,IP:127.0.0.1" 2>/dev/null
fi

echo "[data-server] Starting all services via supervisord..."
exec supervisord -n -c /etc/supervisor/conf.d/data-server.conf
