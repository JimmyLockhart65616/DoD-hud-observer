# DoD HUD Observer — Claude Context

## Project Goal
Retrofit the CS 1.6 HUD Observer into a **Day of Defeat 1.3** live broadcast overlay.
Displays real-time game state (kills, flag captures, player classes, prone shame timer) as an OBS browser source overlay.

## What This Is NOT
- Not an HLTV replay tool (deferred to future scope)
- Not a British team supporter (de-scoped, Allies vs Axis only)
- Not economy-based (DoD has no money/buy system)

---

## Architecture

```
DoD Game Server (hlds + Metamod + AMXX)
  └─ our AMXX plugin (.sma)
       └─ runs a TCP server on PLUGIN_TCP_PORT (default 9000)
       └─ game server has a known public/dedicated IP

Observer's PC (or VPS for production)
  └─ Node.js backend (this repo /backend)
       ├─ connects OUT to game server IP:9000 on startup (no port forwarding needed on observer side)
       ├─ authenticates with PLUGIN_TOKEN
       ├─ relays events via Socket.IO to frontend
       └─ serves REST API (teams, players, matches via LowDB)

  └─ React frontend (this repo /web)
       └─ OBS browser source at http://localhost:3000/screen
```

### Ports
- `3000` — React dev server (OBS browser source)
- `3001` — Node.js backend REST API
- `4000` — Internal Socket.IO server (backend ↔ frontend)
- `9000` — TCP listener for AMXX plugin events (configurable)

### Deployment Modes
- **Local/test**: everything on one PC, AMXX sends to 127.0.0.1:9000
- **Production**: Node backend on a VPS with public IP, game server sends to VPS IP:9000, OBS points browser source at VPS:3000. Switching is one config value change.

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

Source: `dod_hud_observer.sma` (repo root)
Output: `dod-server/mods/dod/addons/amxmodx/plugins/dod_hud_observer.amxx`

Compile using the AMXX compiler inside the Docker container:
```bash
docker compose run --rm --entrypoint="" \
  -v "d:/Git/DoD-hud-observer:/src" \
  hlds sh -c '
    rsync --recursive --update /temp/mods/* /opt/steam/hlds
    cat /src/dod_hud_observer.sma | tr -d "\r" > /tmp/dod_hud_observer.sma
    cd /opt/steam/hlds/dod/addons/amxmodx/scripting
    ./amxxpc /tmp/dod_hud_observer.sma -o/tmp/dod_hud_observer.amxx -i./include
    cp /tmp/dod_hud_observer.amxx /src/dod-server/mods/dod/addons/amxmodx/plugins/dod_hud_observer.amxx
  '
```

### Pawn language notes

- Escape character is `^`, not `\` (no `#pragma ctrlchar` set)
- Double quotes in strings: `^"` (NOT `""` — the AMXX 1.10 compiler rejects `""`)
- Null terminator: `'^0'`
- Backslash is a normal character: `'\'` (single char, no escape needed)

## Docker Server

```bash
docker compose up       # start DoD HLDS with Metamod-P + AMXX
docker compose down     # stop
```

### Stack inside container

- **HLDS**: vanilla Valve build 10211 (`jives/hlds:dod` image)
- **Metamod-P** 1.21p38 (NOT Metamod-R — Metamod-R is for ReHLDS only)
- **AMX Mod X** 1.10.0.5474

### Volume mount structure

```text
dod-server/mods/dod/           → rsync'd to /opt/steam/hlds/dod/
  liblist.gam                  # points gamedll_linux to addons/metamod/metamod.so
  addons/
    metamod/
      metamod.so               # Metamod-P binary
      plugins.ini              # loads amxmodx_mm_i386.so
    amxmodx/
      configs/plugins.ini      # lists dod_hud_observer.amxx
      configs/modules.ini      # sockets, dodfun, dodx uncommented
      plugins/                 # compiled .amxx files go here

dod-server/config/             → rsync'd to /opt/steam/hlds/dod/
  server.cfg
```

---

## Key Files
- `backend/src/handler/server.ts` — TCP listener, parses incoming JSON from AMXX
- `backend/src/socket/socket.ts` — Socket.IO relay to frontend
- `backend/src/routes/apiRouter.ts` — REST API for teams/players/matches
- `web/src/components/core/Socket/Socket.jsx` — all game state logic (Zustand store + event handlers)
- `web/src/components/screen/api/api.js` — weapon name → display info mapping (was numeric IDs)
- `web/src/components/screen/Example.jsx` — main HUD layout
- `config.example.json` — copy to config.json, configure ports and Steam API key
- `dod_hud_observer.sma` — AMXX plugin (to be created at repo root)
