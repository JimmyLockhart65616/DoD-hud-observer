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

- `half_start` includes `timeleft`; `round_start` also includes `timeleft` as a sync point
- `time_sync` fires every 30 seconds to correct frontend clock drift
- Frontend stores `timeleft` + `timeleft_at` (browser `Date.now()`) and counts down locally
- All `timeleft` values come from `hud_timeleft()`, NOT raw `get_timeleft()`: in a match the
  half clock is anchored at the `ktp_match_start` forward (`gametime + mp_timelimit·60`),
  because DoD rebases the real half end at KTPMatchHandler's go-live `mp_clan_restartround`
  while `get_timeleft()` counts from map load (its restart rebase only parses CS TextMsg
  tokens). Raw `get_timeleft()` would run ahead by the ready-up duration and pin the HUD at
  0:00 for minutes at half end. Pubs (no anchor) fall back to `get_timeleft()`.

### Player Events
```json
{ "event": "player_connect", "user_id": "STEAM_0:0:123", "name": "PlayerName", "team": "allies|axis" }
{ "event": "player_disconnect", "user_id": "STEAM_0:0:123" }
{ "event": "player_team_change", "user_id": "STEAM_0:0:123", "team": "allies|axis" }
{ "event": "player_spawn", "user_id": "STEAM_0:0:123", "team": "allies|axis",
  "class_id": 0, "weapon_primary": "garand", "weapon_secondary": "colt" }
{ "event": "player_score", "user_id": "STEAM_0:0:123", "kills": 0, "deaths": 0, "score": 0, "obj_score": 0,
  "damage": 0, "assists": 0, "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0,
  "caps": 0, "cap_breaks": 0, "best_streak": 0 }
{ "event": "kill", "killer_id": "STEAM_0:0:123", "victim_id": "STEAM_0:0:456",
  "weapon": "garand", "kill_type": "normal|suicide|teamkill", "kill_class": "gun|nade",
  "headshot": false, "victim_prone": false, "killer_prone": false,
  "assist_ids": ["STEAM_0:0:789"] }
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
{ "event": "cap_break", "flag_id": 0, "flag_name": "Allied Plaza", "reason": "kill",
  "breaker_id": "STEAM_0:0:456", "broke_team": "allies|axis" }
```

- `flag_captured` is emitted ~0.5s AFTER `dod_control_point_captured` (a per-CP
  one-shot `set_task`), so `captor_ids` carries the captors that `dod_score_event`
  credited (it fires ~0.25s deferred). Emitting synchronously read an empty batch
  (the long-standing empty-captor_ids/capout_by bug).
- `cap_break` (reason `kill`) = an enemy killed a capper on the point, removing
  them from the capture zone (confirmed by an in-zone count drop the next poll).
  `breaker_id` is the killer (credited `cap_breaks`); `broke_team` is the capping
  team that lost the capper. The only per-player-attributable break in extension
  mode (counts only, no zone identity) — step-off / enemy-contest are `flag_cap_stopped`
  / `flag_cap_contested`, unattributed.

### Stats Events (popups: cap flash, round/halftime/match-end boards)

```json
{ "event": "half_end", "half": 1, "allies_score": 2, "axis_score": 1 }
{ "event": "player_stats_summary", "reason": "round_end|half_end|match_end|manual",
  "capout_team": "allies|axis", "capout_by": "Player1, Player2",
  "players": [
    { "user_id": "STEAM_0:0:123", "name": "PlayerName", "team": "allies|axis",
      "kills": 0, "deaths": 0, "assists": 0, "damage": 0,
      "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0, "obj_score": 0,
      "caps": 0, "cap_breaks": 0, "best_streak": 0 }
  ]
}
```

- `reason` `round_end` is a full **capout**; `capout_team`/`capout_by` (the team + the
  names of the final flag's captors) are present only on that reason and title the board.

- Accumulators are half-scoped (reset on `ktp_match_start`), slot-scoped (reset on
  connect/disconnect). Assist = 50+ enemy damage to a victim since their last spawn,
  killed by someone else. `kill_class` "nade" = wpnindex ∈ {13,14,15,16,36} (grenades + mills bomb).
  `cap_breaks` = defensive stat: killed an enemy capper standing on the point (separate
  from `caps`, which is offensive). Credited via the breaker's `player_score`.
- `half_end` + a `half_end`-reason summary fire when the plugin sees KTPMatchHandler's
  `KTP_HALF_END` log line (half-1 end only); `ktp_match_end` covers all terminal paths.
- Summary emission is event-driven only (cap / capout / half end / match end /
  rcon `amx_hud_statsboard`) — never from repeating tasks (half-1 wedge immunity).
- Frontend boards: render-time TTL by reason (`hud.json` settings), dismissed when the
  next half goes live; match-end board sums the cached half-1 summary with final-half
  rows for full-match totals.

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
npm run backend       # backend with hot reload
npm run web           # React dev server
npm run mocker        # simulate events without a real server
npm run test          # Jest — backend unit + integration tests
npm run test:web      # Jest (CRA) — frontend store-machine tests
npm run test:all      # backend + frontend Jest suites
npm run plugin:smoke  # Tier 1 build-time smoke for KTPHudObserver.amxx
```

## Plugin Smoke (Tier 1)

`npm run plugin:smoke` (= `scripts/plugin-smoke.sh`) reproduces the exact
`compile_plugin` invocation Tony's CI runs in `KTPInfrastructure/build/plugins/Dockerfile`:

```sh
amxxpc KTPHudObserver.sma -i./include -i/build/plugins/KTPHudObserver -o.../KTPHudObserver.amxx
```

Sources the compiler + includes from `../KTPInfrastructure/artifacts/latest/ktpamx/scripting/`.
If artifacts are missing, run `cd ../KTPInfrastructure && make build-amxx` once.

Exit codes:

- `0` clean compile
- `1` compile failed
- `2` unexpected warning (only the documented `client_disconnect` deprecation is allowed)
- `3` environment problem (missing artifacts, no docker)

Use this after every `.sma` edit before deploying. Catches every CI compile failure
locally in ~10s on warm Docker.

## Mocker

`npm run mocker` replays a scripted 6v6 scrim against the backend. Events are
wrapped in the same envelope `KTPHudObserver.amxx` emits (tick, plugin_sent_at,
match_id, map, match_type, half) so ingest, recorder, and frontend see an
identical shape. The sequence is ~75s long, then the mocker POSTs a final
`ktp_match_end` and exits — the match on disk is closed cleanly every run.

Env-var overrides (useful for testing HUD behavior per match type):

- `MOCKER_MATCH_TYPE` — 0=COMPETITIVE, 1=SCRIM (default), 2=12MAN, 3=DRAFT, 4=KTP_OT, 5=DRAFT_OT
- `MOCKER_HALF` — 1/2 for regulation, 101+ for OT
- `MOCKER_INGEST_URL` — defaults to `http://localhost:8088/ingest`
- `MOCKER_AUTH_KEY` — defaults to `changeme` (must match backend `config.yaml`)

`npm run mocker -- --socket` is a legacy path that bypasses the backend and
emits directly over Socket.IO; only used by the Playwright config.

## Backend Testing (Jest)

`npm run test` runs the full backend suite (~2s, 124 tests). Exercises ingest
→ MatchRecorder → disk → REST read-back in-process, no servers needed:

- [backend/src/\_\_tests\_\_/ingest.test.ts](backend/src/__tests__/ingest.test.ts) — `POST /ingest` auth, validation, all 6 match types, back-to-back matches, duplicate-start behavior, stats round-trip + snapshot replay
- [backend/src/\_\_tests\_\_/ingestChaos.test.ts](backend/src/__tests__/ingestChaos.test.ts) — adversarial 6v6 robustness: out-of-order arrivals (score/kill before connect), reconnect/rename/team-swap mid-match, malformed/partial/duplicate summaries, unknown-user rows, dropped `ktp_match_start`, rapid OT boundaries, two-server isolation, malformed-event burst
- [backend/src/\_\_tests\_\_/matchRecorder.test.ts](backend/src/__tests__/matchRecorder.test.ts) — `MatchRecorder` startMatch/recordEvent/endMatch + multi-match isolation
- [backend/src/\_\_tests\_\_/matchesApi.test.ts](backend/src/__tests__/matchesApi.test.ts) — `/api/matches/live|stored|:id/events` read-back after ingest
- [backend/src/\_\_tests\_\_/mockerLifecycle.test.ts](backend/src/__tests__/mockerLifecycle.test.ts) — drives `MockerClass` in-process with fake timers; asserts the whole scripted match round-trips through ingest → disk in order

Run a single suite: `npm run test -- <pattern>` (e.g. `npm run test -- mockerLifecycle`).

## Frontend Store Tests (Jest via CRA)

`npm run test:web` runs the React store-machine suite via `react-scripts test`
(jsdom, ~2s). These drive the real Socket.jsx event handlers through the shared
`gameEvents` bus — the same path the live socket uses — and assert the
cumulative-stats state machine (the `halfRows`/`halfSource`/`recordHalf`/
`carrySoFar`/`handleHalfBoundary` carry logic and the half_end-vs-summary
precedence) survives adversarial 6v6 orderings:

- [web/src/components/core/Socket/Socket.chaos.test.js](web/src/components/core/Socket/Socket.chaos.test.js) — summary-vs-marker precedence (both orderings), dropped-summary snapshot fallback, match-end cumulative totals (best_streak MAX'd), signal-less H2→OT boundary, prod double-boundary (ktp_match_start + half_start) counted once, reconnect + halftime team-swap carry by user_id, fresh-match carry/board reset, capout title

Mechanics: `socket.io-client` is mocked at module load (no real connection);
each test mounts a fresh component (RTL auto-unmounts between tests, clearing
`gameEvents` handlers) and opens with a half-1 boundary emit, which resets the
module-level carry globals + store exactly as production does. `web/package.json`
adds a `moduleNameMapper` for `react`/`react-dom` because `zustand` is hoisted to
the **root** `node_modules` while `react` lives in `web/node_modules` (webpack
resolves this via `resolve.modules`; jest's relative resolver needs the map).

`npm run test:all` runs backend + frontend. Both suites also gate `git push`
(pre-push stages 3 + 4; stage 4 self-skips if web deps aren't installed).

## E2E Testing (Playwright)

Uses Playwright with headless Chromium to visually verify the HUD overlay.
The mocker provides a ~75-second scripted 6v6 match sequence — no game server needed.

**Ports:** e2e runs the React dev server on **:3010** and the mocker on **:8000**
so it never collides with the Docker `data` container's production-bundle React on
:3000. `reuseExistingServer` is OFF on both — a stale process fails the run fast
instead of silently testing the wrong stack.

### Commands

```bash
npm run e2e            # automated: starts mocker + React (on :3010), walks timeline, takes 9 screenshots
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
(Windows volume mounts cause read issues for the compiler).

The host-side prelude computes git SHA + UTC build time and passes them through env vars;
the inner shell writes them to `include/build_info.inc` so `ktp_version_reporter` can report
them via the `amx_ktp_versions` rcon command. `jives/hlds:dod` doesn't ship git, hence the
host-side `git rev-parse`.

```bash
GIT_SHA=$(git -C /d/Git/DoD-hud-observer rev-parse --short HEAD 2>/dev/null || echo "unknown")
GIT_DIRTY=""
if [ "$GIT_SHA" != "unknown" ]; then
    if ! git -C /d/Git/DoD-hud-observer diff --quiet 2>/dev/null \
       || ! git -C /d/Git/DoD-hud-observer diff --cached --quiet 2>/dev/null; then
        GIT_DIRTY="-dirty"
    fi
fi
BUILD_TIME=$(date -u +%Y-%m-%dT%H:%MZ)

docker run --rm --entrypoint sh \
  -e KTP_BUILD_SHA="${GIT_SHA}${GIT_DIRTY}" \
  -e KTP_BUILD_TIME="$BUILD_TIME" \
  -v "d:/Git/DoD-hud-observer:/src" \
  -v "d:/Git/KTPInfrastructure:/infra" \
  jives/hlds:dod -c '
    mkdir -p /tmp/compile/include
    cp /infra/artifacts/latest/ktpamx/scripting/include/*.inc /tmp/compile/include/
    cp /infra/artifacts/latest/ktpamx/scripting/amxxpc /tmp/compile/
    cp /infra/artifacts/latest/ktpamx/scripting/amxxpc32.so /tmp/compile/
    printf "#define KTP_BUILD_SHA \"%s\"\n#define KTP_BUILD_TIME \"%s\"\n" "$KTP_BUILD_SHA" "$KTP_BUILD_TIME" > /tmp/compile/include/build_info.inc
    cat /src/KTPHudObserver.sma | tr -d "\r" > /tmp/compile/KTPHudObserver.sma
    cd /tmp/compile
    chmod +x amxxpc
    ./amxxpc KTPHudObserver.sma -oKTPHudObserver.amxx
    cp KTPHudObserver.amxx /infra/local/plugins/KTPHudObserver.amxx
  '
```

Expected: 1 warning (`client_disconnect` deprecated — harmless, DODX still fires it).
Expected output size: ~19 KB.

### Deploying the compiled plugin

- **Local test env**: compiled `.amxx` ends up in `../KTPInfrastructure/local/plugins/`, which is volume-mounted into the game-server containers. Restart the container or reload plugins to pick up changes.
- **Whole fleet (binary sync, fan-out)**: run `./deploy/distribute-plugin.sh` (or drop the `.amxx` at `/home/dod/distribute/addons/ktpamx/plugins/KTPHudObserver.amxx` on the data server, 74.91.112.242 / `neindataatl`). The `ktp-file-distributor` (.NET 8 systemd worker) preserves the path **relative to the watch dir** and SFTPs it to every server in `servers.json` (all 25 instances, all `enabled`) within ~5s, notifying Discord. **The drop subpath matters** — a file dropped at the watch-dir root lands in the dod gamedir root, not `plugins/`, and won't load. Distribution makes the binary *present* fleet-wide but it only **loads** where `plugins.ini` lists it (dormant elsewhere — intended, so the HUD stays opt-in per server). Activates at each server's next restart.
- **Single server (canary / enable, e.g. Denver 5 only)**: `./deploy/deploy-plugin.sh cadaver@<server-ip> dod-<port>` pushes + restarts one server; add `--bootstrap` for a first-time install (it writes the `KTPHudObserver.amxx debug` line under the "Custom - Add 3rd party plugins" section of `configs/plugins.ini` + the `hud_observer.cfg` exec line, then restarts). This is the path for canarying a new build on ONE server before `distribute-plugin.sh` fans it out, and for enabling/disabling the HUD on a given server.

### Deploying the backend/frontend

Our Node.js backend + React frontend ship to the data server (`cadaver@74.91.112.242`) via `./deploy/deploy.sh`. See [deploy/README.md](deploy/README.md) for commands, one-time setup, firewall rules, and systemd unit layout.

Game-server/plugin fan-out to the 25-server fleet is handled by Tony's tooling in `KTPInfrastructure` (`make deploy-denver` / `make deploy-plugins` → `deploy/deploy.py`); see [KTPInfrastructure/docs/DEPLOYING.md](../KTPInfrastructure/docs/DEPLOYING.md) for the authoritative playbook.

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

Breaking `KTPAMXX` or `KTPInfrastructure` corrupts every downstream plugin, including our own. The authoritative deploy playbook is [KTPInfrastructure/docs/DEPLOYING.md](../KTPInfrastructure/docs/DEPLOYING.md).

Install the pre-push hooks once per machine (they run a full Docker build before push — this is the CI, there is no GH Actions pipeline):

```bash
cd ../KTPInfrastructure && bash scripts/install-hooks.sh
cd ../KTPAMXX           && bash scripts/install-hooks.sh
cd ../DoD-hud-observer  && bash scripts/install-hooks.sh
```

Our hook (`scripts/pre-push.sh`) runs three stages: amxxcurl async-lifetime
lint (awk), `amxxpc` compile of `KTPHudObserver.sma`, then `npm run test`.
Bypass with `git push --no-verify` or `KTP_SKIP_PREPUSH=1`. Requires
KTPInfrastructure as a sibling directory (same as the KTPAMXX hook).

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
- `config/local/config.yaml` — local-dev backend config (committed; ports, auth key, storage). Production uses `config/online/config.yaml` (gitignored, operator-owned), selected via `HUD_CONFIG_PATH` env var. Template: `config/online/config.yaml.example`.
- `data-server/Dockerfile` — build source for the KTPInfrastructure data container
- `dod_hud_observer.sma` — legacy plugin (vanilla Metamod version, kept for reference)
