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

# Ensure demo directories exist
mkdir -p /opt/hltv/instance-1/demos /opt/hltv/instance-2/demos

echo "[data-server] Starting all services via supervisord..."
exec supervisord -n -c /etc/supervisor/conf.d/data-server.conf
