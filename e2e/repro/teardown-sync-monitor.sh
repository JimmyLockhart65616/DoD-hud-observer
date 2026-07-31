#!/usr/bin/env bash
# Tear down the durable HLTV↔overlay sync monitor on the data server (run THERE
# as cadaver). Stops + removes the logger and the 3 relays and their configs.
# Logs under /opt/sync-monitor/logs are RETAINED for analysis unless you remove
# them. Counterpart to deploy-sync-monitor.sh.
set +e
sudo systemctl disable --now sync-health.timer 2>/dev/null
sudo systemctl disable --now sync-logger 2>/dev/null
sudo systemctl disable --now sync-relay@27060 sync-relay@27061 sync-relay@27062 2>/dev/null
sudo rm -f /etc/systemd/system/sync-logger.service /etc/systemd/system/sync-relay@.service \
           /etc/systemd/system/sync-health.service /etc/systemd/system/sync-health.timer
sudo rm -f /home/hltvserver/hlds/configs/hltv-27060.cfg \
           /home/hltvserver/hlds/configs/hltv-27061.cfg \
           /home/hltvserver/hlds/configs/hltv-27062.cfg
sudo pkill -f "port 2706" 2>/dev/null
sudo systemctl daemon-reload
echo "[teardown] services + relays + configs removed."
echo "[teardown] logs retained: /opt/sync-monitor/logs  (remove with: sudo rm -rf /opt/sync-monitor)"
