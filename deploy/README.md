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

## Config

`/opt/hud-observer/config.yaml` is overwritten by every deploy. If you need per-environment values (auth key, ports), set them in the systemd unit via `Environment=` lines (see `HUD_AUTH_KEY`, `HUD_INGEST_PORT`, etc. in `config.yaml`'s header).

## Logs

```bash
sudo tail -f /var/log/hud-observer/backend.log
sudo tail -f /var/log/hud-observer/web.log
sudo journalctl -u hud-observer -f
```
