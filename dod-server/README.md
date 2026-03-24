# DoD Test Server (Docker)

Runs a local Day of Defeat 1.3 server for testing the HUD Observer plugin.

## Prerequisites

- Docker Desktop installed and running
- Node.js (for the backend)

## What you need to place manually (gitignored binaries)

### Metamod-R
Download from: https://github.com/rehlds/Metamod-R/releases

Place `metamod_i386.so` (and optionally `metamod.dll`) directly in:
```
dod-server/mods/addons/metamod/
```

### AMX Mod X 1.10 Linux + DoD add-on
Download from: https://www.amxmodx.org/downloads.php
- AMX Mod X 1.10 Base (Linux)
- Day of Defeat add-on (Linux)

Extract both into `dod-server/mods/` — they will populate:
```
dod-server/mods/addons/amxmodx/
  dlls/
    amxmodx_mm_i386.so        ← from base package
  modules/
    dodfun_amxx_i386.so       ← from DoD add-on
    dodx_amxx_i386.so         ← from DoD add-on
  configs/                    ← already in repo (our configs)
  plugins/                    ← put compiled .amxx here
```

### Compiled plugin
Compile `dod_hud_observer.sma` at https://www.amxmodx.org/compiler.php
Place the resulting `dod_hud_observer.amxx` in:
```
dod-server/mods/addons/amxmodx/plugins/
```

## Full folder structure (after setup)

```
dod-server/
  config/
    server.cfg
  mods/
    addons/
      metamod/
        metamod_i386.so       ← download
        plugins.ini           ← in repo
        config.ini            ← in repo
      amxmodx/
        dlls/
          amxmodx_mm_i386.so  ← from AMX Mod X download
        modules/
          dodfun_amxx_i386.so ← from DoD add-on download
          dodx_amxx_i386.so   ← from DoD add-on download
        configs/
          plugins.ini         ← in repo
          amxx.cfg            ← in repo
        plugins/
          dod_hud_observer.amxx ← compile from .sma
```

## Running

### 1. Copy config
```bash
cp config.example.json config.json
```
Default config uses `127.0.0.1:9000` — correct for local testing.

### 2. Start everything

Terminal 1 — DoD server:
```bash
docker compose up
```

Terminal 2 — Node backend:
```bash
npm run backend
```

Terminal 3 — React frontend:
```bash
npm run web
```

Connect in-game: `connect 127.0.0.1`

Open overlay: `http://localhost:3000`

## Notes

- `host.docker.internal` in `amxx.cfg` resolves to your host machine from inside Docker on Windows/Mac. On Linux replace with your LAN IP.
- The token in `amxx.cfg` must match `PLUGIN_TOKEN` in `config.json`.
- Change the map in `docker-compose.yml` to any DoD map (e.g. `dod_flash`, `dod_donner`).
- RCON password is `changeme` by default — change in both `server.cfg` and `docker-compose.yml`.
