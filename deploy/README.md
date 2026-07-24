# Deploy

Two independent pipelines:

- **Data server** (this file, below) — Node backend + React frontend → `cadaver@74.91.112.242` via `deploy.sh`.
- **Game-server plugin** — `KTPHudObserver.amxx` → the whole fleet via
  `distribute-plugin.sh` (KTPFileDistributor), or one server at a time via
  `deploy-plugin.sh` (see [Plugin deploy](#plugin-deploy)).

---

## Data server (backend + frontend)

Target: `cadaver@74.91.112.242`, app dir `/opt/hud-observer`.

### Routine deploy

```bash
./deploy/deploy.sh               # backend + frontend
./deploy/deploy.sh --backend     # backend only
./deploy/deploy.sh --frontend    # frontend only
./deploy/deploy.sh --dry-run     # preview rsync, no remote changes
```

### One-time setup on the data server

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

### First-time deploy order

1. Run `./deploy/deploy.sh` from your workstation — it will fail at the `systemctl restart` step because the unit doesn't exist yet. That's expected; files are on the server.
2. SSH in and do the one-time setup above.
3. Re-run `./deploy/deploy.sh` — should be clean.

### Firewall (UFW)

The data server exposes four HUD ports. Three are public (OBS needs them); the ingest port is locked to the game server.

| Port | Purpose | UFW rule |
| --- | --- | --- |
| 3000 | Frontend (OBS browser source) | open to world |
| 3001 | Backend REST API | open to world |
| 4000 | Socket.IO (frontend ↔ backend) | open to world |
| 9000 | Plugin HTTP ingest (`POST /ingest`) | restricted to Denver 5 (`66.163.114.109`) |

Only Denver 5 posts events right now, so 9000 stays pinhole-only. When another game server starts sending, add its IP with `sudo ufw allow from <ip> to any port 9000 proto tcp`. Never open 9000 to the world — the auth key is the only other gate.

Port 9000 (not 8088) because 8088 was already bound by an unrelated "KTP AC API" on the box. Override lives in `Environment=HUD_INGEST_PORT=9000` in the systemd unit.

### Friendly URL — nginx vhost (`hud.ktpdod.com`)

Casters/viewers/OBS should use `https://hud.ktpdod.com/screen?server=...`, not a
raw `IP:3000` URL. The data box already runs nginx on :80; a vhost fans one
HTTPS origin out to the three app processes so there are no ports in the URL and
no mixed-content/CORS breakage (see [nginx/hud.ktpdod.com.conf](nginx/hud.ktpdod.com.conf)
for the full config + the box-specific header comments):

```
/            → 127.0.0.1:3000   (React overlay, the existing `serve` unit)
/api/* /health /metrics → 127.0.0.1:3001
/socket.io/  → 127.0.0.1:4000   (WebSocket upgrade)
```

Ingest (:9000) is **not** proxied — it stays a direct IP-restricted POST.

One-time setup on the box:

```bash
ssh cadaver@74.91.112.242
sudo nginx -T                       # inspect existing layout / for a *.ktpdod.com cert
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
# place deploy/nginx/hud.ktpdod.com.conf per the box convention, then:
sudo certbot --nginx -d hud.ktpdod.com   # unless a wildcard cert already exists
sudo nginx -t && sudo systemctl reload nginx
```

The **frontend must be built against this origin** (already the `deploy.sh`
default: `REACT_APP_API_URL`/`REACT_APP_SOCKET_URL=https://hud.ktpdod.com`) and
the online config's `frontend.origin` must equal `https://hud.ktpdod.com` (the
Socket.IO CORS origin). Verify end to end: `curl -sSf https://hud.ktpdod.com/health`,
then load the OBS URL during a live/mocker match and confirm the overlay renders
with a clean dev console.

#### Local mirror — `https://localhost` (zero setup)

The docker stack runs the same nginx single-origin proxy **on :443 with a :80
redirect** as prod. The frontend is **origin-relative** (no baked hostname), so
the same image serves `https://localhost` locally and `https://hud.ktpdod.com` in
prod. No hosts file, no mkcert — `start.sh` self-signs a fallback cert (SAN
includes `localhost`) so nginx just starts:

```bash
docker compose up -d --build                       # this repo (data only)
#   or the whole KTP stack (game servers → plugin → ingest → overlay):
#   cd ../KTPInfrastructure && DOD_HUD_PATH=../DoD-hud-observer make local-up-full

npm run proxy:smoke                                # zero-arg check (https://localhost, -k)
#   then open  https://localhost/screen?server=...
```

Because the fallback cert is self-signed, the browser warns once — click
**Advanced → Proceed** (Chrome: type `thisisunsafe` on the warning; Firefox: add
the exception). The page is then a real HTTPS/`wss` secure context, exactly as in
prod. The cert dir (`data-server/certs/`) is gitignored (machine-specific).

##### Optional — trusted green padlock (and OBS browser source)

OBS's embedded Chromium won't click through a self-signed cert, so for OBS (or if
you just want no warning) drop in a locally-trusted mkcert cert — no rebuild
needed, the container picks it up on next start:

```bash
choco install mkcert && mkcert -install            # or: scoop install mkcert
mkdir -p data-server/certs
mkcert -cert-file data-server/certs/hud.ktpdod.com.pem \
       -key-file  data-server/certs/hud.ktpdod.com-key.pem \
       localhost 127.0.0.1                          # add hud.ktpdod.com to test that exact origin
docker compose restart data                         # picks up the mounted cert
```

To exercise the **exact prod origin** `https://hud.ktpdod.com` locally, also add
`127.0.0.1  hud.ktpdod.com` to your hosts file and set the backend
`frontend.origin` to `https://hud.ktpdod.com` — but `https://localhost` covers
the full HTTPS/`wss`/single-origin path without it.

### Config

The repo follows the KTPInfrastructure split:

- `config/local/config.yaml` — committed, safe dev defaults. Used by `npm run backend`, the docker test stack, and CI. Shipped to the data server by every deploy.
- `config/online/config.yaml` — **gitignored**, operator-owned. Lives at `/opt/hud-observer/config/online/config.yaml` on the data server and contains the real ingest auth key + HLTV rcon passwords. `deploy.sh` never touches it.
- `config/online/config.yaml.example` — committed template. Copy to `config/online/config.yaml` for first-time setup.

Which one the backend loads is controlled by `HUD_CONFIG_PATH` in the systemd unit (defaults to `/opt/hud-observer/config/online/config.yaml` per `deploy/hud-observer.service.example`). Per-secret overrides like `HUD_AUTH_KEY`, `HUD_INGEST_PORT`, etc. still work via `Environment=` lines on the unit.

#### One-time bootstrap of the online config

```bash
ssh cadaver@74.91.112.242
sudo mkdir -p /opt/hud-observer/config/online
sudo cp /opt/hud-observer/config/online/config.yaml.example \
        /opt/hud-observer/config/online/config.yaml
sudo nano /opt/hud-observer/config/online/config.yaml   # fill in auth_key + rcon passwords
sudo systemctl restart hud-observer
```

### Logs

```bash
sudo tail -f /var/log/hud-observer/backend.log
sudo tail -f /var/log/hud-observer/web.log
sudo journalctl -u hud-observer -f
```

---

## Plugin deploy

`KTPHudObserver.amxx` is **excluded** from Tony's centralised `deploy.py`
(KTPInfrastructure) — we own its rollout. Two paths, split by intent: keep the
binary current everywhere, vs. choose where it actually runs.

### Fleet sync — `distribute-plugin.sh` (the everyday "push my latest" path)

```bash
./deploy/distribute-plugin.sh --dry-run   # show the drop, change nothing
./deploy/distribute-plugin.sh             # confirm, then drop to the fleet
./deploy/distribute-plugin.sh --yes       # skip the confirm prompt
```

Drops the compiled binary into the data server's **KTPFileDistributor** watch
dir at `/home/dod/distribute/addons/ktpamx/plugins/KTPHudObserver.amxx`. The
`ktp-file-distributor` systemd worker on `neindataatl` (74.91.112.242) SFTPs it
to **every** server in `servers.json` — all 25 KTP instances, all `enabled` —
within ~5s and posts to Discord. This keeps the binary byte-identical fleet-wide
in one command, with no per-server SSH keys on your workstation (the distributor
holds the fan-out key).

**Distributing the binary does not enable it.** A server only *loads*
KTPHudObserver if its `plugins.ini` lists `KTPHudObserver.amxx`. Servers without
that line hold the newest binary **dormant** on disk — intended, so the HUD stays
opt-in per server (perf isolation / player choice). The distributor overwrites
the live `.amxx`; a running server keeps the old bytecode in memory until its
next restart (nightly 3 AM or manual), so there's no mid-match swap.

> The drop posts a success/failure message to Tony's Discord — it's an audit
> trail, not a private op. **Canary first** (below), then distribute fleet-wide.

### Canary / enable a single server — `deploy-plugin.sh`

```bash
./deploy/deploy-plugin.sh <user@host> <instance>              # push + restart one server
./deploy/deploy-plugin.sh --bootstrap <user@host> <instance> # first-time: also adds the
                                                              # plugins.ini line + cfg exec
./deploy/deploy-plugin.sh --stage <user@host> <instance>     # drop .new, swap at 3 AM (no bounce)
```

Use this to canary a new build on **one** server before a fleet drop, or to
**enable** the HUD somewhere (`--bootstrap` writes the `KTPHudObserver.amxx debug`
line into that server's `plugins.ini` + the `hud_observer.cfg` exec line, then
restarts). Run with `--help` for all flags.

### Enable / disable a server

- **Enable:** `deploy-plugin.sh --bootstrap <user@host> <instance>` (adds the
  `plugins.ini` line). It loads at the next restart; the dormant binary is
  already current if you've been running fleet sync.
- **Disable:** comment the `KTPHudObserver.amxx` line in that server's
  `plugins.ini` and restart. Fleet sync keeps refreshing the dormant binary but
  it won't load. Disabling is about player choice / perf isolation, not ingest
  load — that scales with concurrent *active* matches POSTing, not server count.

Both scripts default the binary to the documented compile output
`../KTPInfrastructure/local/plugins/KTPHudObserver.amxx` (override with
`--plugin <path>`) and warn if it's older than `KTPHudObserver.sma`. **Recompile
before deploying** — see CLAUDE.md → "Compiling the AMXX Plugin".
