#!/bin/bash
# KTP Data Server startup script
# Initializes MySQL on first run, then starts supervisord

set -e

# ============================================
# MySQL initialization (first run only)
# ============================================
if [ ! -d "/var/lib/mysql/mysql" ]; then
    echo "[data-server] First run — initializing MySQL..."
    mysqld --initialize-insecure --user=mysql 2>&1

    # Start MySQL temporarily to create HLStatsX database
    mysqld --user=mysql &
    MYSQL_PID=$!

    # Wait for MySQL to be ready
    for i in $(seq 1 30); do
        if mysqladmin ping --silent 2>/dev/null; then
            break
        fi
        sleep 1
    done

    mysql -u root <<-EOF
        CREATE DATABASE IF NOT EXISTS hlstatsx;
        CREATE USER IF NOT EXISTS 'hlstatsx'@'localhost' IDENTIFIED BY 'ktptest';
        GRANT ALL PRIVILEGES ON hlstatsx.* TO 'hlstatsx'@'localhost';
        FLUSH PRIVILEGES;
EOF
    echo "[data-server] MySQL initialized. Database: hlstatsx"

    mysqladmin shutdown
    wait $MYSQL_PID 2>/dev/null || true
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
