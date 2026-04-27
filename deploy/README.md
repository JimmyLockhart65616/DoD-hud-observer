# Deploy to data server

Target: `cadaver@74.91.112.242`, app dir `/opt/hud-observer`.

## Routine deploy

```bash
./deploy/deploy.sh               # backend + frontend
./deploy/deploy.sh --backend     # backend only
./deploy/deploy.sh --frontend    # frontend only
./deploy/deploy.sh --dry-run     # preview rsync, no remote changes
```

## One-time setup on the data server

```bash
ssh cadaver@74.91.112.242

# Node.js 20 LTS (if not already installed)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# App dir + log dir
sudo mkdir -p /opt/hud-observer /var/log/hud-observer
sudo chown cadaver:cadaver /opt/hud-observer /var/log/hud-observer

# serve (for the static frontend) — installed globally once
sudo npm install -g serve

# Install systemd units (after first deploy has placed files). The real
# hud-observer.service lives outside git (contains HUD_AUTH_KEY); copy the
# checked-in .example alongside it and edit in place if you ever lose the copy.
sudo cp /opt/hud-observer/deploy/hud-observer.service     /etc/systemd/system/
sudo cp /opt/hud-observer/deploy/hud-observer-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hud-observer hud-observer-web
```

(`cadaver` already has `NOPASSWD: ALL` sudo, so no sudoers rule is needed.)

## First-time deploy order

1. Run `./deploy/deploy.sh` from your workstation — it will fail at the `systemctl restart` step because the unit doesn't exist yet. That's expected; files are on the server.
2. SSH in and do the one-time setup above.
3. Re-run `./deploy/deploy.sh` — should be clean.

## Firewall (UFW)

The data server exposes four HUD ports. Three are public (OBS needs them); the ingest port is locked to the game server.

| Port | Purpose | UFW rule |
| --- | --- | --- |
| 3000 | Frontend (OBS browser source) | open to world |
| 3001 | Backend REST API | open to world |
| 4000 | Socket.IO (frontend ↔ backend) | open to world |
| 9000 | Plugin HTTP ingest (`POST /ingest`) | restricted to Denver 5 (`66.163.114.109`) |

Only Denver 5 posts events right now, so 9000 stays pinhole-only. When another game server starts sending, add its IP with `sudo ufw allow from <ip> to any port 9000 proto tcp`. Never open 9000 to the world — the auth key is the only other gate.

Port 9000 (not 8088) because 8088 was already bound by an unrelated "KTP AC API" on the box. Override lives in `Environment=HUD_INGEST_PORT=9000` in the systemd unit.

## Config

The repo follows the KTPInfrastructure split:

- `config/local/config.yaml` — committed, safe dev defaults. Used by `npm run backend`, the docker test stack, and CI. Shipped to the data server by every deploy.
- `config/online/config.yaml` — **gitignored**, operator-owned. Lives at `/opt/hud-observer/config/online/config.yaml` on the data server and contains the real ingest auth key + HLTV rcon passwords. `deploy.sh` never touches it.
- `config/online/config.yaml.example` — committed template. Copy to `config/online/config.yaml` for first-time setup.

Which one the backend loads is controlled by `HUD_CONFIG_PATH` in the systemd unit (defaults to `/opt/hud-observer/config/online/config.yaml` per `deploy/hud-observer.service.example`). Per-secret overrides like `HUD_AUTH_KEY`, `HUD_INGEST_PORT`, etc. still work via `Environment=` lines on the unit.

### One-time bootstrap of the online config

```bash
ssh cadaver@74.91.112.242
sudo mkdir -p /opt/hud-observer/config/online
sudo cp /opt/hud-observer/config/online/config.yaml.example \
        /opt/hud-observer/config/online/config.yaml
sudo nano /opt/hud-observer/config/online/config.yaml   # fill in auth_key + rcon passwords
sudo systemctl restart hud-observer
```

## Logs

```bash
sudo tail -f /var/log/hud-observer/backend.log
sudo tail -f /var/log/hud-observer/web.log
sudo journalctl -u hud-observer -f
```
