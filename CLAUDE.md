# DoD HUD Observer — Claude Context

## Project Goal
Retrofit the CS 1.6 HUD Observer Project into a **Day of Defeat 1.3** live broadcast overlay, and integrate with KTP League infrastructure and systems.
Displays real-time game state (kills, flag captures, player classes, prone shame timer) as an OBS browser source overlay.

## What This Is NOT
- Not an HLTV replay tool (deferred to future scope)
- Not a British team supporter (de-scoped, Allies vs Axis only)
- Not economy-based (DoD has no money/buy system)

---

## Architecture

```
KTP-ReHLDS Game Server (KTPAMXX extension mode — NO Metamod)
  └─ KTPHudObserver.amxx
       └─ HTTP POSTs JSON events via KTPAMXXCurl to backend :8088
       └─ hooks ktp_match_start/end from KTPMatchHandler
       └─ uses DODX forwards for spawn/death/prone/cap/team events

Data Server (or local dev machine)
  └─ Node.js backend (this repo /backend)
       ├─ Express HTTP ingest on :8088 (X-Auth-Key auth)
       ├─ MatchRecorder → events.jsonl + metadata.json per matchId
       ├─ Socket.IO rooms keyed by matchId on :4000
       └─ REST API on :3001 (teams, players, matches)

  └─ React frontend (this repo /web)
       └─ OBS browser source at http://localhost:3000/screen
```

### Ports
- `3000` — React dev server (OBS browser source)
- `3001` — Node.js backend REST API
- `4000` — Internal Socket.IO server (backend ↔ frontend)
- `8088` — HTTP ingest endpoint (plugin POSTs events here)

### Deployment Modes
- **Local/test**: everything on one PC, AMXX sends to 127.0.0.1:9000
- **Production**: Node backend on a VPS with public IP, game server sends to VPS IP:9000, OBS points browser source at VPS:3000. Switching is one config value change.

### Extension-mode constraint (HARD RULE)

**Nothing in the game-server pipeline may depend on Metamod or any of its dependencies.** The production KTP stack loads AMXX modules in "extension mode" — only `dodx_ktp`, `reapi_ktp`, `amxxcurl_ktp` are loaded per `../KTPInfrastructure/config/online/modules.ini`. No fakemeta, no hamsandwich, no engine module, no Metamod-P/R.

When adding natives (to dodx, reapi, or a new KTP module):
- Use HL SDK directly (`edict->v.*`, `gpGlobals`, `g_engfuncs`) — these are available in extension mode
- Use existing dodx extension-mode natives (`dodx_get_user_origin`, `dodx_get_user_movetype`, etc.) from plugins instead of pev/entity_get_*
- Do not use `META_*` macros or `MDLL_*` wrappers
- New modules must handle `g_bExtensionMode` branching (dodx is the reference implementation)

---

## Match Format
- **6v6**, two halves on the same map (teams swap sides at half time)
- **Half 1**: Team A plays Allies, Team B plays Axis
- **Half 2**: Teams swap — same map, opposite sides
- Stats reset on `half_start` event — previous half stats not shown on current half HUD
- Players may disconnect/reconnect mid-round or between halves

---

## Teams
- **Allies** vs **Axis** only (British team de-scoped)
- Team assignment tracked per-player via `player_connect` and `player_team_change` events

---

## Player Identity
- `user_id` = Steam ID (persistent across disconnect/reconnect within a session)
- Display name comes from `player_connect` event (`name` field = in-game name)
- On `half_start`: wipe all player stats, keep player roster (they'll re-send `player_spawn`)
- Dproto (non-Steam) fake IDs are acceptable — identity only needs to be unique within a match session

---

## Class IDs

### Allied Classes
| class_id | Name | Primary Weapon |
|---|---|---|
| 0 | Rifleman | garand |
| 1 | Staff Sergeant | carbine |
| 2 | Master Sergeant | thompson |
| 3 | Light Machinegunner | bar |
| 4 | Sniper | spring |
| 5 | Rocket | bazooka |

### Axis Classes
| class_id | Name | Primary Weapon |
|---|---|---|
| 0 | Grenadier | k98 |
| 1 | Stosstruppe | k43 |
| 2 | Unteroffizier | mp40 |
| 3 | Sturmtruppe | mp44 |
| 4 | Scharfschütze | k98s |
| 5 | Panzerschreck | pschreck |
| 6 | Maschinengewehr | mg42 |

---

## Weapon Names
Use AMXX log weapon name strings (not numeric IDs like CS version).
Examples: `"garand"`, `"mp40"`, `"bar"`, `"mg42"`, `"knife_allies"`, `"spade"`

---

## Event Schema

All events are JSON objects sent over TCP from the AMXX plugin.

Every event is automatically injected with a `"tick"` field (seconds since map load, float)
by `do_send_json()`. This is used for replay event ordering and future HLTV demo sync.

### Round Events
```json
{ "tick": 1.00, "event": "round_start_freeze" }
{ "tick": 4.00, "event": "round_start", "timeleft": 1197 }
{ "tick": 30.0, "event": "round_end", "winner": "allies|axis|draw",
  "end_type": "objectives|time_limit|allies_eliminated|axis_eliminated",
  "allies_score": 0, "axis_score": 0 }
{ "tick": 0.05, "event": "half_start", "half": 1, "timeleft": 1200 }
{ "tick": 38.1, "event": "team_score", "allies_score": 0, "axis_score": 0 }
{ "tick": 25.0, "event": "time_sync", "timeleft": 1175 }
```

### Timer

- `half_start` includes `timeleft` (seconds remaining from `get_timeleft()` / `mp_timelimit`)
- `round_start` also includes `timeleft` as a sync point
- `time_sync` fires every 30 seconds to correct frontend clock drift
- Frontend stores `timeleft` + `timeleft_at` (browser `Date.now()`) and counts down locally

### Player Events
```json
{ "event": "player_connect", "user_id": "STEAM_0:0:123", "name": "PlayerName", "team": "allies|axis" }
{ "event": "player_disconnect", "user_id": "STEAM_0:0:123" }
{ "event": "player_team_change", "user_id": "STEAM_0:0:123", "team": "allies|axis" }
{ "event": "player_spawn", "user_id": "STEAM_0:0:123", "team": "allies|axis",
  "class_id": 0, "weapon_primary": "garand", "weapon_secondary": "colt" }
{ "event": "player_score", "user_id": "STEAM_0:0:123", "kills": 0, "deaths": 0, "score": 0 }
{ "event": "kill", "killer_id": "STEAM_0:0:123", "victim_id": "STEAM_0:0:456",
  "weapon": "garand", "kill_type": "normal|suicide|teamkill", "victim_prone": false }
{ "event": "prone_change", "user_id": "STEAM_0:0:123",
  "state": "standing|prone|deployed", "timestamp": 1234567890000 }
{ "event": "weapon_pickup", "user_id": "STEAM_0:0:123", "weapon": "mp40" }
{ "event": "weapon_drop",   "user_id": "STEAM_0:0:123", "weapon": "mp40" }
{ "event": "nade_throw", "user_id": "STEAM_0:0:123",
  "nade_type": "frag_allies|frag_axis|riflegren_allies|riflegren_axis|smoke_allies|smoke_axis" }
{ "event": "caster_observed_player", "user_id": "STEAM_0:0:123" }
{ "event": "user_say", "user_id": "STEAM_0:0:123", "team_only": false, "message": "gg" }
```

### Flag Events
```json
{ "event": "flags_init", "flags": [
    { "flag_id": 0, "flag_name": "Allied Plaza", "owner": "allies|axis|neutral" }
  ]
}
{ "event": "flag_cap_started", "flag_id": 0, "flag_name": "Allied Plaza",
  "capping_team": "allies|axis", "captor_ids": ["STEAM_0:0:123"] }
{ "event": "flag_cap_stopped", "flag_id": 0, "flag_name": "Allied Plaza",
  "capping_team": "allies|axis" }
{ "event": "flag_captured", "flag_id": 0, "flag_name": "Allied Plaza",
  "new_owner": "allies|axis", "captor_ids": ["STEAM_0:0:123"] }
```

---

## Prone Shame Timer
- `prone_change` with `state: "prone"` or `state: "deployed"` includes a `timestamp` (unix ms from server)
- Frontend calculates elapsed prone time from that timestamp
- HUD displays a visible shame timer next to the player while prone
- On `kill` event, `victim_prone: true` can be noted in the kill feed ("killed while proning")
- Timer clears on `prone_change` with `state: "standing"` or on `kill`/`player_spawn`

---

## What Was Removed from CS Version
- All bomb/C4 events (plant, defuse, explode)
- Money tracking and buy events
- Kevlar/armor system
- Flashbang/wallbang/headshot kill modifiers (keep headshot? TBD)
- Numeric weapon ID system → replaced with string log names
- CT/T team sides → Allies/Axis
- Map pool / BO1/BO3/BO5 match type display (may re-add later)

---

## Tech Stack (unchanged from CS version)
- **Backend**: Node.js, TypeScript, Express, Socket.IO, LowDB
- **Frontend**: React (CRA), Zustand, Socket.IO client
- **AMXX Plugin**: Pawn scripting language (.sma), compiled with AMXX compiler
- **Dev**: nodemon + ts-node for backend, react-scripts for frontend

## Dev Commands
```bash
npm run backend   # backend with hot reload
npm run web       # React dev server
npm run mocker    # simulate events without a real server
```

## E2E Testing (Playwright)

Uses Playwright with headless Chromium to visually verify the HUD overlay.
The mocker provides a 55-second scripted 6v6 match sequence — no game server needed.

### Commands

```bash
npm run e2e            # automated: starts mocker + React, walks timeline, takes 10 screenshots
npm run e2e:headed     # same but with visible browser window
npm run e2e:screenshot # ad-hoc: take a single screenshot (servers must be running)
```

### Ad-hoc screenshot tool

Requires mocker + React already running (`npm run mocker` + `npm run web:mocker`):

```bash
npx ts-node e2e/screenshot-tool.ts                                  # wait 5s, take screenshot
npx ts-node e2e/screenshot-tool.ts --wait 15000 --name after-kills  # wait 15s
npx ts-node e2e/screenshot-tool.ts --selector ".flags-container"    # wait for CSS selector
```
Screenshots save to `e2e/snapshots/` (gitignored). Claude can read these PNGs to visually inspect the HUD.

### How Claude should use E2E tests

1. After making frontend changes, run `npm run e2e` to verify the HUD still renders correctly
2. Read screenshots from `e2e/snapshots/*.png` to visually check layout, colors, and data
3. For iterative debugging: start servers in background, use the screenshot tool between edits
4. The mocker auto-starts its event sequence when the frontend connects — restart mocker to replay

### Test structure

- `e2e/hud-timeline.spec.ts` — main test, 10 checkpoints along the mocker timeline
- `e2e/helpers/wait-helpers.ts` — DOM wait utilities (players, kills, flags)
- `e2e/helpers/screenshot.ts` — screenshot helper
- `e2e/helpers/mocker-timeline.ts` — named timestamp constants from mocker data

## Compiling the AMXX Plugin

Source: `KTPHudObserver.sma` (repo root)
Output: `../KTPInfrastructure/local/plugins/KTPHudObserver.amxx`
(mounted into game server containers at startup via `local/plugins/` volume)

Compile using the AMXX compiler from the KTPInfrastructure artifacts. The compiler resolves
includes relative to its own directory, so everything must be copied to `/tmp` first
(Windows volume mounts cause read issues for the compiler):

```bash
docker run --rm --entrypoint sh \
  -v "d:/Git/DoD-hud-observer:/src" \
  -v "d:/Git/KTPInfrastructure:/infra" \
  jives/hlds:dod -c '
    mkdir -p /tmp/compile/include
    cp /infra/artifacts/latest/ktpamx/scripting/include/*.inc /tmp/compile/include/
    cp /infra/artifacts/latest/ktpamx/scripting/amxxpc /tmp/compile/
    cp /infra/artifacts/latest/ktpamx/scripting/amxxpc32.so /tmp/compile/
    cat /src/KTPHudObserver.sma | tr -d "\r" > /tmp/compile/KTPHudObserver.sma
    cd /tmp/compile
    chmod +x amxxpc
    ./amxxpc KTPHudObserver.sma -oKTPHudObserver.amxx
    cp KTPHudObserver.amxx /infra/local/plugins/KTPHudObserver.amxx
  '
```

Expected: 1 warning (`client_disconnect` deprecated — harmless, DODX still fires it).
Expected output size: ~14.7 KB.

### Deploying the compiled plugin

- **Local test env**: compiled `.amxx` ends up in `../KTPInfrastructure/local/plugins/`, which is volume-mounted into the game-server containers. Restart the container or reload plugins to pick up changes.
- **All 25 production servers (fan-out)**: drop the `.amxx` into `/home/dod/distribute/` on the data server (74.91.112.242). KTPFileDistributor (.NET 8 systemd worker) SFTPs it to every server and notifies Discord.
- **Single production server (targeted, e.g. Denver 5 only)**: `scp` directly into `cadaver@<server-ip>:/home/dodserver/dod-<port>/serverfiles/dod/addons/ktpamx/plugins/KTPHudObserver.amxx` and skip KTPFileDistributor. Add `KTPHudObserver.amxx debug` under the "Custom - Add 3rd party plugins" section of `configs/plugins.ini` if not already present. Reload via `rcon restart` or `changelevel`.

### Pawn language notes

- Escape character is `^`, not `\` (no `#pragma ctrlchar` set)
- Double quotes in strings: `^"` (NOT `""` — the AMXX 1.10 compiler rejects `""`)
- Null terminator: `'^0'`
- Backslash is a normal character: `'\'` (single char, no escape needed)

## Docker Environment

Game servers and the full KTP stack are managed in **KTPInfrastructure** (`../KTPInfrastructure`).
This repo provides the application source (backend + frontend + plugin) that KTPInfrastructure builds and deploys.

### Running the full stack (game servers + data server)

```bash
cd ../KTPInfrastructure
make local-up           # builds + starts ktp-game-1, ktp-game-2, data (3 containers)
make local-down         # stop
make local-logs         # tail all logs
docker compose -f docker-compose.local.yml logs -f data   # data server only
```

### Containers (defined in KTPInfrastructure/docker-compose.local.yml)

- **`ktp-game-1`** — KTP-ReHLDS + KTPAMXX, dod_anzio. Ports: 27016 (game), 26900 (HLTV src)
- **`ktp-game-2`** — KTP-ReHLDS + KTPAMXX, dod_flash. Ports: 27017 (game), 26901 (HLTV src)
- **`data`** — All data server processes (supervisord). Ports: 3000 (frontend), 3001 (REST), 4000 (Socket.IO), 8088 (plugin ingest), 27020-21 (HLTV proxies), 27500 (HLStatsX UDP)

### Data server processes (inside `data` container)

- **`mysql`** — HLStatsX database
- **`hltv-1`** — HLTV proxy → ktp-game-1
- **`hltv-2`** — HLTV proxy → ktp-game-2
- **`hlstatsx-stub`** — UDP log receiver on :27500 (socat stub)
- **`backend`** — Node.js HUD Observer (REST + Socket.IO + HTTP ingest)
- **`frontend`** — React build served statically on :3000

### Standalone data server (no game servers)

If you only need the backend/frontend (e.g. for mocker-based frontend development):

```bash
docker compose up -d    # runs data container only from this repo
docker compose down
```

### KTPInfrastructure config for this repo

```text
KTPInfrastructure/config/local/config.yaml          → backend config (auth key, ports)
KTPInfrastructure/config/local/plugins.ini          → includes KTPHudObserver.amxx
KTPInfrastructure/config/local/dodserver.cfg        → dod_hud_url = http://data:8088/ingest
KTPInfrastructure/local/plugins/KTPHudObserver.amxx → compiled plugin (see above)
KTPInfrastructure/test-env/data/hltv-1.cfg          → HLTV proxy config
KTPInfrastructure/test-env/data/demos/              → HLTV demo recordings
```

### Legacy reference

`docker-compose.legacy.yml` — kept for reference only. Vanilla HLDS + Metamod-P setup.
Do not use for active development.

---

## Pushing to KTP Dependency Repos

Breaking `KTPAMXX` or `KTPInfrastructure` corrupts every downstream plugin,
including our own. Before pushing to either repo, see
[docs/KTP_PUSH_WORKFLOW.md](docs/KTP_PUSH_WORKFLOW.md) — covers the pre-push
hook, GitHub Actions, and the Denver-before-prod deploy sequence.

Install the pre-push hooks once:

```bash
cd ../KTPInfrastructure && bash scripts/install-hooks.sh
cd ../KTPAMXX           && bash scripts/install-hooks.sh
```

---

## Key Files
- `KTPHudObserver.sma` — AMXX plugin source (KTP stack: curl + DODX, no Metamod)
- `backend/src/handler/ingest.ts` — HTTP ingest endpoint (POST /ingest, X-Auth-Key)
- `backend/src/handler/matchRecorder.ts` — per-match events.jsonl + metadata.json
- `backend/src/handler/metrics.ts` — /metrics endpoint (EPS, per-source, latency)
- `backend/src/config.ts` — YAML config loader with env-var overrides
- `backend/src/socket/socket.ts` — Socket.IO rooms (matchId-keyed)
- `backend/src/routes/apiRouter.ts` — REST API for teams/players/matches
- `web/src/components/core/Socket/Socket.jsx` — all game state logic (Zustand store + event handlers)
- `web/src/components/screen/api/api.js` — weapon name → display info mapping
- `web/src/components/screen/Example.jsx` — main HUD layout
- `config.yaml` — backend configuration (ports, auth key, storage)
- `data-server/Dockerfile` — build source for the KTPInfrastructure data container
- `dod_hud_observer.sma` — legacy plugin (vanilla Metamod version, kept for reference)
- `docs/KTP_PUSH_WORKFLOW.md` — safety playbook for pushing to KTPAMXX / KTPInfrastructure
