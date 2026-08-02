#!/usr/bin/env bash
# Deploy the durable HLTV↔overlay sync monitor on the data server (run THERE as
# cadaver; uses sudo). Installs 3 delay-0 relays (CHI1/NY1/ATL1) + the logger,
# all under systemd (Restart=always). Expects sync-logger.js + lib/ staged in
# ~/sync-stage. Idempotent. Teardown: e2e/repro/teardown-sync-monitor.sh.
#
# RETIRED 2026-08-02 — the offset investigation this instruments is CLOSED
# (see SYNC-MEASUREMENT.md "RESOLVED (2026-07-03)"). Do not re-deploy without a
# reason; these relays cost ~7% of a core each and are pure measurement load.
set -e
RELAY_PW="${1:-syncrelay}"

# ── install dir ──────────────────────────────────────────────────────────────
sudo mkdir -p /opt/sync-monitor/logs
sudo cp ~/sync-stage/sync-logger.js /opt/sync-monitor/
sudo rm -rf /opt/sync-monitor/lib && sudo cp -r ~/sync-stage/lib /opt/sync-monitor/
sudo chown -R cadaver:cadaver /opt/sync-monitor

# ── relay configs (relayPort:masterPort:name) — autoretry self-connects ──────
for pair in "27060:27040:chi1" "27061:27035:ny1" "27062:27020:atl1"; do
    rp=${pair%%:*}; rest=${pair#*:}; mp=${rest%%:*}; nm=${rest##*:}
    sudo -u hltvserver tee /home/hltvserver/hlds/configs/hltv-$rp.cfg >/dev/null <<EOF
name "sync-relay-$nm"
hostname "sync-relay-$nm"
maxclients 4
delay 0
adminpassword "$RELAY_PW"
nomaster 1
autoretry 1
connect "127.0.0.1:$mp"
EOF
done

# ── systemd units ────────────────────────────────────────────────────────────
sudo tee /etc/systemd/system/sync-relay@.service >/dev/null <<'EOF'
[Unit]
Description=KTP sync measurement relay %i
After=network.target
[Service]
User=hltvserver
Group=hltvserver
# REQUIRED — without it hltv cannot dlopen steamclient.so and enters an
# unthrottled SteamAPI_Init retry loop: ~7% of a core per relay and a flood of
# "[S_API FAIL] ... dlopen failed" to syslog (measured 2026-08-02: 3 relays put
# 46 GiB into /var/log/syslog.1 in under 3 days). Production hltv@.service has
# this line; the first version of this unit did not.
Environment="LD_LIBRARY_PATH=/home/hltvserver/hlds"
WorkingDirectory=/home/hltvserver/hlds
ExecStart=/home/hltvserver/hlds/hltv -game dod -port %i +exec configs/hltv-%i.cfg
StandardInput=null
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/sync-logger.service >/dev/null <<EOF
[Unit]
Description=KTP HLTV-overlay sync monitor
After=network.target hud-observer.service
[Service]
Type=simple
User=cadaver
WorkingDirectory=/opt/sync-monitor
Environment=NODE_PATH=/opt/hud-observer/node_modules
Environment=SYNC_LOG_DIR=/opt/sync-monitor/logs
Environment=SYNC_RELAY_PW=$RELAY_PW
ExecStart=/usr/bin/node /opt/sync-monitor/sync-logger.js
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
EOF

# ── replace the manual test relay (if any) with systemd-managed ones ─────────
sudo pkill -f "port 27060" 2>/dev/null || true
sleep 2
sudo systemctl daemon-reload
echo "[deploy] starting relays..."
sudo systemctl enable --now sync-relay@27060 sync-relay@27061 sync-relay@27062
sleep 9
echo "[deploy] starting logger..."
sudo systemctl enable --now sync-logger
sleep 12

echo "[deploy] === status ==="
systemctl is-active sync-relay@27060 sync-relay@27061 sync-relay@27062 sync-logger || true
echo "[deploy] === logger journal ==="
sudo journalctl -u sync-logger -n 6 --no-pager | tail -6
echo "[deploy] === csv tail ==="
tail -4 /opt/sync-monitor/logs/sync-*.csv 2>/dev/null || echo "(no csv yet)"
