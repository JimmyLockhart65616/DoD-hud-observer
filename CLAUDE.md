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
       ├─ OBS browser source at http://localhost:3000/screen
       └─ HQ operations board at http://localhost:3000/hq (all servers, one screen)
```

### HQ / Operations Board (`/hq`)

A wall display showing every reporting server at once — status, map, score, half
clock, flag ownership and per-player K/D — for a venue monitor. One full-width
strip per server, ordered by hostname, authored on a fixed 1920×1080 canvas that
`transform: scale()`s to fit any display (`?scale=` overrides for on-site nudging).

Deliberately **polls `GET /api/hq` at 1 Hz instead of using Socket.IO**:
`Socket.jsx` connects at module scope and its Zustand store + 8 module globals are
a hard singleton, so it cannot serve N servers on one page. Nothing under
`web/src/components/hq/` may import from `core/Socket/Socket` — enforced by
`Hq.socketfree.test.js`, which also asserts every `Hq.css` selector is `.hq-`
prefixed (CRA emits one global stylesheet shared with the live overlay's
`Screen.css`, so an unprefixed rule would restyle `/screen`).

`/api/hq` (`backend/src/handler/hqBoard.ts`) is a read-only projection over the
per-server state cache in `ingest.ts` + MatchRecorder + MetricsCollector, composed
server-side so every field on a strip comes from one instant. Two notes:

- **It reflects the post-delay cache.** `updateServerState` runs inside
  `makeFireToSockets`, i.e. after the HLTV delay buffer, so any server in
  `hltv_sync.servers` is shown ~`delaySeconds` behind live (60s on the league
  fleet). Surfaced per strip as `delayActive`/`delaySeconds`. Servers absent from
  that config are effectively live — the lag is a config property, not a code one.
- **Statuses** (first match wins): `NO_SIGNAL` (no ingest <60s) → `STALE`
  (signal, no cache — the backend-restart window) → `BETWEEN` → `LIVE` (a round
  has begun) → `WARMUP`. `BETWEEN` keys on the additive `matchActive` field, NOT
  on `half`, which `ktp_match_end` deliberately leaves set. Score/clock/flags are
  suppressed on non-LIVE/WARMUP strips: the cache is never evicted, so an offline
  server would otherwise show a client-side clock ticking down forever.
- **Map fallback chain**: cache → active match metadata → HLTV RCON status →
  last recorded match. The plugin only stamps `map` on events while a match is
  active, so a server that hasn't started one since the last backend restart has
  no cache value at all — the RCON status map (from `hltv_sync`, independent of
  match state) fills that gap for HLTV-paired servers.

### Server & Match Picker (`/watch`)

The entry page: every server that has ever POSTed an event, plus live and stored
matches. Rows are the `/api/servers` projection in
[backend/src/handler/serverList.ts](backend/src/handler/serverList.ts) —
composed server-side so ordering and HLTV pairing are testable, not re-derived
per client.

- **Fleet order comes from the backend**, via `compareServerHostnames`, which is
  numeric-aware (`localeCompare(..., {numeric:true})` plus a raw tiebreak for a
  total order). `getServers()` iterates a Map in first-POST-after-boot order, so
  without this the list reshuffles on every backend restart. `/hq` shares the
  same comparator. The fleet is single-digit today — which is exactly why plain
  `localeCompare` would look fine right up until a region reaches ten.
- **Each row carries an HLTV connect address**, rendered as a
  `steam://connect/<host>:<port>` link: Steam queries the address, works out it's
  a GoldSrc DoD server, and launches + connects. The visible link text is the
  literal address so it can also be pasted after `connect` in the console when a
  browser won't hand off the protocol.
- **`hltv_connect` is NOT `hltv_sync`.** They look alike and are not:
  `hltv_sync.servers` is the **RCON** endpoint this backend polls for the
  broadcast clock — `127.0.0.1` (backend and proxies share the data server) and
  carrying rcon passwords, so it is operator-owned and gitignored.
  `hltv_connect` is the **public** address a DoD client dials, holds no secret,
  and must cover every server on the picker whether we sync its clock or not.
  Reusing either for the other's job gives a dead link or a leaked password.
  (Both cover all 24 servers as of 2026-08-23; `hltv_sync` was 5 before that,
  the rest running on the fixed `fallback_delay_seconds` instead of a measured
  clock. All 24 proxies share one adminpassword.)
- All 24 proxies run on the data server, one per game server, allocated in
  per-region blocks of five: Atlanta 27020, Dallas 27025, Denver 27030, New York
  27035, Chicago 27040 (Chicago has four). `config/online/config.yaml.example`
  is the committed record of that map; the live source of truth is each
  `hltv-<port>.cfg` in `/home/hltvserver/hlds/configs`, whose `connect` line
  names the game server it mirrors.
- An empty `hltv_connect.host` (the committed local default, or
  `HUD_HLTV_CONNECT_HOST=`) renders no links at all rather than half a connect
  string; a server absent from `ports` shows `—`, which is correct for the
  hand-run LAN boxes that report to ingest but have no proxy.

### Ports
- `3000` — React dev server (OBS browser source `/screen`, HQ board `/hq`)
- `3001` — Node.js backend REST API
- `4000` — Internal Socket.IO server (backend ↔ frontend)
- `8088` — HTTP ingest endpoint (plugin POSTs events here)

**Single-origin reverse proxy (nginx).** The overlay is served single-origin so
the HTTPS page (and OBS's embedded Chromium) never hits a cross-origin /
mixed-content wall, and so Socket.IO's `credentials:true` CORS origin matches
the serving origin. nginx fans `/` → :3000, `/api/*` + `/health` + `/metrics` →
:3001, `/socket.io/` → :4000; ingest (:9000 prod / :8088 local) is **never**
proxied (direct IP-restricted POST from game servers).
- **Prod**: `https://hud.ktpdod.com` on :443 (nginx already runs on the data
  box; we add a vhost — `deploy/nginx/hud.ktpdod.com.conf`). The frontend bundle
  is built against this origin (`deploy/deploy.sh`); `frontend.origin` in the
  online config must equal it.
- **Local docker**: `https://localhost` on :443 (:80 redirect) → nginx inside the
  `data` container (`data-server/nginx-hud.conf`, supervisord `[program:nginx]`).
  Zero setup: the frontend is **origin-relative** (no baked hostname — same image
  serves localhost and prod), and `start.sh` self-signs a fallback cert (SAN
  `localhost`) so `up` just works (browser warns once). Optional mkcert cert in
  `data-server/certs/` (gitignored) for a trusted padlock / OBS. Verify with
  `npm run proxy:smoke`; runbook in [deploy/README.md](deploy/README.md).

The frontend reads `REACT_APP_SOCKET_URL`/`REACT_APP_API_URL` when set (dev:
`npm run web` uses split ports) and otherwise falls back to
`window.location.origin` / relative `/api` — so single-origin proxy builds carry
no origin at all. Prod's `deploy.sh` still injects `https://hud.ktpdod.com`
inline (to beat the developer's `.env.local` without deleting it).

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

### Broadcast team names (caster-editable)

The `ALLIES`/`AXIS` labels in the top bar and on the stats board are display-only
overrides resolved by `web/src/components/core/TeamName/teamNames.js`, in order:
`?allies=`/`?axis=` query params → `localStorage['hud.team_names']` → the side
default. Nothing reaches the backend, the plugin or match metadata — a name is
typed once on the machine running the overlay and is not part of match state, so
there is nothing to provision per match and nothing to reset afterwards.

- Edited in place on `/screen`: **double-click**, type, Enter (`EditableTeamName`).
  Double, never single — this renders on air. OBS only forwards mouse events while
  a source is in Interact mode, so the resting overlay is unaffected.
- A URL-pinned side renders as plain text with **no editor**: an edit that silently
  loses to the URL on the next reload is worse than no edit control.
- ⇄ (edit mode only) swaps the pair for the halftime side change. It swaps the
  STORED pair, so a side left at its default stays at its default rather than
  having the literal string `AXIS` written onto it.
- Names bind to the SIDE, not to a roster. Teams swap at halftime — that is what
  ⇄ is for; nothing swaps them automatically.
- `StatsTable` reads the same names, so the board can't say `ALLIES` while the bar
  above it says the team. `/hq` deliberately does NOT — it shows many servers at
  once and one browser's local override would be wrong on most of the strips.
- Contract pinned by `teamNames.test.js`.

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
- `timeleft` is FRACTIONAL (`%.2f`) since plugin 2.1.0 — the frontend floors only at
  display (matching the DoD client's rounding); flooring at emission added up to 1s of
  phase error vs the client clock
- `time_sync` fires every 30 seconds to correct frontend clock drift
- Frontend stores `timeleft` + `timeleft_at` (browser `Date.now()`) and counts down locally
- All `timeleft` values come from `hud_timeleft()`, NOT raw `get_timeleft()`. Preference
  order: (1) `dodx_get_round_time()` (dodx_ktp 2.7.23+) — CLOSED LOOP: the engine's own
  half-clock accounting (`CDoDTeamPlay::m_flDoDMapTime`, which the go-live
  `mp_clan_restartround` rebases; the restart countdown is projected from
  `m_flRestartRoundTime`), tracks go-live/`.restarthalf`/OT exactly, equals
  `get_timeleft()` on pubs; bound optionally via `plugin_natives`/`set_native_filter`
  so old modules fall through. (2) The open-loop anchor set at `ktp_match_start`
  (`gametime + mp_clan_timer + mp_timelimit·60`) — kept because DoD rebases the real
  half end at the go-live restart while `get_timeleft()` counts from map load (its
  restart rebase only parses CS TextMsg tokens); raw `get_timeleft()` would run ahead
  by the ready-up duration and pin the HUD at 0:00 for minutes. (3) `get_timeleft()`
  (pubs, no anchor).

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
{ "event": "damage", "attacker_id": "STEAM_0:0:123", "victim_id": "STEAM_0:0:456",
  "damage": 40, "damage_raw": 120, "weapon": "garand", "hitplace": 1, "victim_health": -80 }
{ "event": "prone_change", "user_id": "STEAM_0:0:123",
  "state": "standing|prone|deployed", "timestamp": 1234567890000 }
{ "event": "weapon_pickup", "user_id": "STEAM_0:0:123", "weapon": "mp40" }
{ "event": "weapon_drop",   "user_id": "STEAM_0:0:123", "weapon": "mp40" }
{ "event": "nade_throw", "user_id": "STEAM_0:0:123",
  "nade_type": "frag_allies|frag_axis|riflegren_allies|riflegren_axis|smoke_allies|smoke_axis" }
{ "event": "caster_observed_player", "user_id": "STEAM_0:0:123" }
{ "event": "user_say", "user_id": "STEAM_0:0:123", "team_only": false, "message": "gg" }
```

#### `damage` — applied vs raw

`damage` is **APPLIED damage since plugin 2.5.0**: the health the victim actually
lost, capped at what dodx reported. `damage_raw` is dodx's own number —
`(int)pev->dmg_take` as read in `Client_Health_End`
(`KTPAMXX modules/dod/dodx/usermsg.cpp`), which the game DLL never clamps to the
victim's remaining health (`pev->dmg_take += flTake` then `pev->health -= flTake`,
so health goes negative).

Crediting raw meant the killing blow's overkill was banked in full. On the NY1
fixture that inflated 1086 hits from ~61,000 to **95,608 — 37% of every damage
number was health the victim never had**, with 53.6% of hits overkilling and
per-player inflation of +42% to +77%. `damage` is the StatsBoard's default sort key
**and** its MVP award (`StatsTable.jsx`), so this flipped the MVP on 2 of 4
team-halves and re-ordered rows on 3 of 4. It was never a cosmetic error.

- **Pre-hit health is recovered from `g_last_health[]`**, seeded on spawn and at the
  roster dump (`ktp_match_start` wipes every slot immediately before that dump) and
  updated from the post-hit `get_user_health(victim)` on **every** hit — including
  self, fall and team damage, which credit nothing but still move health. That
  update sits deliberately **outside** the `attacker != victim && !TK` accumulate
  gate; move it inside and the next enemy hit reads a stale-high baseline and
  silently over-reports again.
- **The cap is `min(damage, health_drop)`, not `damage + min(victim_health, 0)`.**
  `KTPGrenadeDamage.amxx` is deployed fleet-wide and reduces grenade damage through
  dodx's `dod_damage_pre` heal-back, which dodx **skips when the victim is already
  dead** while still forwarding the reduced number. Subtracting raw overkill from a
  reduced value under-reports, sometimes to 0.
- Validated on all 1086 fixture events: `victim_health + damage` always lands in
  `(0,100]`, so the pre-hit health is reliably recoverable. Pinned by
  `backend/src/__tests__/damageCorrection.test.ts`, which also pins the naive model's
  total so a future "simplification" fails loudly.
- `victim_health` is **unchanged** and is still the health-bar source
  (`ingest.ts`, `Socket.jsx`). `damage_raw` is audit-only — nothing on the render
  path reads it. Guarded by the `damage-applied-bound` invariant
  (`0 <= damage <= damage_raw`), which is gated on `damage_raw` being present so it
  is a no-op on every pre-2.5.0 capture.
- `hits` / `hs_hits` still count a hit that applies 0 damage. A hit is a hit.

### Live State Events (socket-only — never persisted)

```json
{ "event": "weapon_active", "user_id": "STEAM_0:0:123", "weapon": "garand" }
{ "event": "player_state",
  "waves": { "allies": { "in": 3.25, "pending": 2 },
             "axis":   { "in": 7.75, "pending": 4 } },
  "scoring": { "in": 12.75, "every": 30.50, "allies": 4, "axis": 2 },
  "players": [
    { "user_id": "STEAM_0:0:123", "weapon": "garand", "nades": 2,
      "health": 100, "prone_state": "standing|prone|deployed" }
  ]
}
```

These drive the live weapon icon and grenade pips on the player cards, the
reinforcement-wave pill above each team's card strip, and the territorial
scoring-tick countdown + projected points in the top-bar score pill.

- `weapon_active` is forward-driven (`dod_client_weaponswitch`), so it is immune to the half-1 task wedge. `player_state` is the 4 Hz `task_poll_player_state` batch and is not.
- `player_state` carries **only alive players** — dead players are omitted rather than sent with zeroes, and the store leaves omitted players untouched. The POST is skipped when there is nothing at all to say, but an empty `players` array still ships if a wave clock or the scoring tick is running: a full team wipe is exactly when those matter.
- **Buffer budget.** `task_poll_player_state` guards at `BUFFER_SIZE - 576`, the sum of everything appended after the check: one more player row (192) + the `waves` block (96) + the `scoring` block (96) + `post_event`'s envelope prefix (165) + 27 slack. Adding another trailing block means redoing that arithmetic, not guessing — the comment at the guard carries the table.
- Both are in `SOCKET_ONLY_EVENTS` (`ingest.ts`): fanned out to sockets but **not** written to `events.jsonl`, and there is **no reducer arm and no cache**, so a join snapshot carries no weapon/grenade data — a reloading overlay shows nothing until the next tick. This is also why event-stream invariants cannot cover them: the production fixture contains zero `player_state` records.
- `nades` comes from `dodx_get_grenade_ammo`, a raw pdata read at a **runtime-detected offset**, and is **three-valued**: a positive count, a real `0` (empty pool), and **negative = "could not resolve"**. The plugin passes a negative through **unclamped**; `Socket.jsx` normalises `< 0` to `null`, and the card renders *no pip at all* for null while a real `0` keeps a dimmed pip. Getting this wrong is not cosmetic — until dodx 2.7.32 every failure path in that native returned `0`, indistinguishable from an empty pool, so a wrong offset yielded plausible, stable, entirely fabricated counts (KTPAMXX#15). The card compounded it with `?? 0`, so *unknown* was drawn on air as *none* — which also hit every player on a freshly-reloaded overlay, since `player_state` is socket-only and carries no join snapshot. **The fleet must reach 2.7.32 before the negative ever appears**; on older modules the unknown arm is unreachable and only the reload case improves. Store contract in `Socket.nades.test.js`; the mocker's full-roster snapshot carries one `-1` so `npm run e2e` keeps exercising the hidden-pip path.
- `nade_throw` above is documented but **never emitted by the plugin** (a CS-era leftover); `Socket.jsx` increments a `nades_thrown` field no component reads. Do not build on it.

#### Reinforcement wave clock (`waves`)

DoD respawn is a **per-team reinforcement wave**, not a per-player countdown. The
clock is idle while a side has nobody waiting, **arms on the death that takes it
from 0 waiting to 1**, then fires every `mp_clan_respawntime` seconds returning
everyone flagged ready. So a player who dies just before a wave is back almost
instantly and one who dies just after waits a full period, and the two sides'
phases are unrelated — never derive one from the other.

- **A side is omitted whenever its clock is idle or unreadable**, and the store
  nulls an omitted side rather than leaving it stale (`Socket.waves.test.js`).
  The overlay hides that pill. A countdown still ticking after everyone
  respawned is worse on air than no countdown.
- `in` is seconds-REMAINING, never an absolute gametime — the frontend stamps the
  receipt instant and counts down locally, exactly like `timeleft`/`timeleft_at`.
  Since the HLTV delay buffer releases the event, receipt time *is* broadcast
  time and no delay arithmetic is needed anywhere.
- `pending` is still emitted but is **deliberately not rendered** (caster
  feedback 2026-08-09: redundant, the dead player cards already show who is
  waiting). It is kept on the wire because it is the same count the clock gates
  on server-side and costs nothing, and dropping it would mean a fleet plugin
  redeploy for one integer — but do not treat it as dead like `nade_throw`: the
  store still records it, nothing reads it. If you re-surface it, note it can
  over-count a player who isn't ready to spawn yet
  (`CBasePlayer::m_imissedwave` — DoD makes them miss the wave); there is no
  extension-mode read for `m_irdytospawn`.
- Source order in `hud_wave_time_f()`: idle → `-1.0`; then `dodx_get_wave_time()`
  (CLOSED LOOP, bound optionally via `set_native_filter` — **no shipped dodx
  exports it yet**); then the open-loop `mp_clan_respawntime` estimate against the
  anchor armed in `client_death`. The estimate is gated on `mp_clan_match` — on a
  pub the period comes from the map, so it would be confidently wrong; hide
  instead. A changelevel makes elapsed negative and drops out, so the clock
  simply hides until the next death re-arms it.
- The estimated deadline is `anchor + mp_clan_respawntime + WAVE_SPAWN_DELAY`
  (2.0s, plugin 2.3.1). Measured on the fleet 2026-08-09: waves land ~2s later
  than the bare cvar, so the panel used to hit `00:00` while the side was still
  waiting. A fixed post-death delay before DoD counts a body as waiting (the
  death cam — `client_death` fires at the kill) and a true period longer than the
  cvar are indistinguishable from outside the engine, and since the estimate now
  runs **exactly one cycle** they are the same arithmetic anyway.
- **The estimate never wraps into a second cycle.** Past the deadline it reads
  `0` for `WAVE_OVERRUN_GRACE` (1.5s, covering its own error so the panel doesn't
  blank a beat before the players appear) and then returns `-1.0`, hiding the
  side until the next 0→1 death re-arms an observed phase. Still waiting past the
  deadline usually means somebody died in the last moments before a wave and
  missed it — invisible in extension mode — so a fresh `00:10` seconds after zero
  is fabricated, and reads on air as the respawn being further away than it is.
  `Socket.jsx` independently drops+latches any side whose remaining time jumps up
  (`WAVE_WRAP_TOLERANCE_SEC`): within one arming it can only fall, and a real
  re-arm always follows an idle poll that nulls the side first. That net exists
  because the frontend deploys instantly while the fleet picks up a new `.amxx`
  on its own restart cycle.
- The anchor **re-anchors on every 0→1 transition** rather than only when empty.
  That is what makes it self-correcting: a stale anchor from an earlier round,
  half or map can't survive a lull, so no invalidation path has to be kept in
  sync with every restart edge.
- **Rendered as the game's own `hud_reinforcements` panel**, not a generic
  badge: gunmetal plate, embossed stencil label, brass-bezel housing of four
  recessed MM:SS windows split by a colon. Every colour is sampled off the real
  sprite — `hud_layout.spr` region `(81,0,129,58)` per `dod/sprites/hud.txt`
  (plate `#4a4a4a`→`#383531`, bezel `#4e452f`/`#2f2718`, near-black recesses,
  `#a7a7a7` highlights). Recreated in CSS rather than shipping the bitmap: it
  scales to any canvas and needs no pixel alignment against a fixed sprite. Our
  waves are always under a minute so it reads `00:07`, the same MM:SS the client
  shows. **DoD DOES show players a reinforcement countdown** — an earlier version
  of this doc claimed it didn't.
- **Placement: centred above each team's card strip, NOT in the top bar.**
  `.flags-bar` is an absolute overlay across the same 72px band as `.top-bar`,
  so at the ~1280 prod OBS canvas the allies side of the top bar is already
  buried behind the flag strip — `e2e/snapshots/fixed-1280x720.png` (June,
  pre-dating this feature) shows the `ALLIES` label itself hidden, a collision
  that is **still unfixed**. Anything added there is invisible on the left at the
  real broadcast width. `.team-wave-row` has a **fixed** height so the card strip
  doesn't bounce when the panel appears or idles out. `/caster` puts the same
  component in `.caster-scoreline`, scaled up as a unit.
- `WavePill` hides itself once its anchor runs `STALE_AFTER_ZERO_SEC` (3s) past
  zero with no refresh. The plugin re-sends at 4 Hz, so a real wave re-anchors
  long before that; only a wedged poll task or a dead server trips it, and
  `00:00` frozen on air reads as a wave that never arrives.

#### Territorial scoring tick (`scoring`)

DoD awards periodic team points for holding control points, from the map's
`dod_control_point_master`, on that entity's own clock. **The game client shows
this NOWHERE** — not the countdown, not the amount — which is the entire reason
it is worth putting on a broadcast overlay: "can Axis hold mid for one more
tick?" is often the whole tactical story of a half and is currently invisible.

**ONE shared clock plus two per-team award numbers** — the map has a single
master — so this is deliberately NOT shaped like `waves`, which is two
independent per-team phases. The two halves also fail independently: the timing
is an observation, the amount is a model.

- **The award rule is `W × count(CPs held by team whose default_owner != team)`.**
  A team banks nothing for sitting on its own home flags; a neutral-default point
  counts for whoever holds it. **No per-flag constant fits** — solving the linear
  system contradicts — so the award genuinely depends on holder-vs-default, and
  `g_flag_default_owner[]` (dodx `CP_default_owner`, i.e. the BSP
  `point_default_owner` parse) is a hard input.
- **`W` is LEARNED online, not read.** The obvious source, `CP_pointvalue`, is
  unusable: the Linux `pd_dcp` branch is one int short so it actually reads
  `m_iIndex` (`docs/dodx-cp-index-space-findings.md`). Each confirmed tick
  derives `W = delta/count`, requiring exact division AND agreement across both
  teams; the first violation latches the numbers off **for the rest of the map**
  and logs the evidence. Published only after `TICK_W_STREAK_REQ` (3) agreeing
  ticks. `dod_hud_score_award 0` kills the numbers by rcon mid-broadcast without
  touching the clock.
- **Validated on exactly ONE recorded map** (`match-1777342963-NY1`,
  `dod_thunder2`, whose CPs carry donner's name tokens), where `W = 2`. Run
  `node e2e/repro/score-tick-analyze.cjs <events.jsonl> --defaults AAnXX` over a
  recording from a second map before trusting the numbers on air there —
  ideally `dod_anzio`, whose all-neutral defaults would directly falsify the
  "non-default" rule. Until then every degradation path above leaves the
  countdown up and the numbers dark, which is the safe direction.
- **Source order**: `dodx_get_score_tick_time()` (CLOSED LOOP, reads
  `CControlPointMaster::m_fGivePointsTime` gated on `m_bActive`; bound optionally
  via `set_native_filter`, shipped in KTPAMXX but **the fleet lags module
  releases**) → the observed-phase estimator → `-1.0`, which omits the whole
  block and hides the panel.
- **The period is MEASURED, never taken from a cvar.** Real spacing is a
  rock-stable **30.50s** against an `m_iGivePointsDelay` of 30 — the master only
  awards on its own 0.5s think — so a cvar-derived estimate slips 0.5s per tick.
  Confirmed three independent ways: TeamScore deltas in the recorded fixture,
  the native's countdown wall-clock on a live local server, and
  `m_fGivePointsTime` itself stepping `33.00 → 63.50`.
- **The period is PER MAP and varies wildly.** Measured locally 2026-08-11:
  `dod_anzio` 30s, **`dod_flash` 900s** (15 minutes). Two consequences, both
  load-bearing:
  - `every` must ride the wire. Without it the store falls back to a fixed 60s
    ceiling and would silently reject **every** update on a long-period map. On
    the closed-loop path the estimator never locks a measured period, so `every`
    comes from `dodx_get_score_tick_period()` (nominal delay + 1.0s, since real
    spacing runs longer than the configured delay).
  - Above `TICK_MAX_USEFUL_PERIOD` (180s) the plugin omits the block entirely.
    The panel answers "can they hold this for one more tick?", which only exists
    when ticks are a recurring beat; on flash the award is vestigial and a
    13-minute countdown beside the score is noise.
  The estimator re-anchors on every observed tick, so it can never drift and can
  never honestly report more than one period; `Socket.jsx` enforces that as a
  ceiling on `in` (the wave clock's "can only fall" guard does NOT apply — this
  is a sawtooth that legitimately jumps back up once per cycle).
- **The discriminator is grid + phase.** Ticks land on an exact 0.5s gametime
  grid; cap awards nearly all do not (75 of 140 score-increase frames on-grid in
  the fixture). Rejected outright: negative deltas (score reset), `>= 20` to one
  team (the +40 capout bonus, and the +118 half-2 seeding KTPMatchHandler writes
  into gamerules), anything inside a restart cascade window, and — while not yet
  locked — any frame within `TICK_CAP_PROXIMITY` of a capture. A cap-dirty frame
  once locked still confirms PHASE but never feeds `W`.
- **A 0/0 tick is COMPLETELY INVISIBLE** — DoD emits no `TeamScore` at all for
  it. Every half opens with ~3 such slots while both teams sit on home flags, so
  the estimator rolls its anchor through silence and only counts a strike when
  the model said something *should* have been awarded. Treating silence as
  failure would drop the lock every single half.
- **The grid re-phases on every round restart** (the fixture's h1 grid breaks at
  the 1109.50 capout and re-locks on a new phase), and is anchored on the go-live
  restart — both halves back-extrapolate to `half_start + ~9.6s` (`mp_clan_timer`).
  So the phase is never derivable, only observable. Cost of the open-loop path:
  ~130s blind at each half start, ~95s to re-lock after a restart, live ~85% of a
  match. The closed-loop native removes all of it.
- **Placement: attached to the score, in the top-bar centre.** The award sits
  under the score digit it is about to change, the countdown under the half
  clock. **Width-neutrality is load-bearing** — `.flags-bar` runs to x≈530 while
  `.score` is ~190px wide, leaving ~15px clearance at the 1280 prod canvas, and
  `.score` is `overflow:hidden`. Both additions are fixed-height slots BELOW
  existing content and add no horizontal extent. `/caster` stacks the same
  components in `.caster-scoreline`; `/hq` deliberately gets nothing.
- **`+0` is real information**, not an absence — it says a side banks nothing on
  the next tick. Guarded by `typeof === 'number'` in the store and by dedicated
  tests both store- and component-side; a plain falsy check is the bug.
- **The algorithm's only executable specification is
  `backend/src/invariants/scoreTick.ts`**, pinned against the production fixture
  (71 ticks, 0 false positives, `W = 2`, locks at h1 393.5 / h1 1204 / h2 223.5)
  plus synthetic streams for the paths that match never reaches. The Pawn side
  mirrors it line for line with identical constant names — change one, change
  both. Event-stream invariants **cannot** cover this: `player_state` is
  socket-only, so no fixture contains a `scoring` block; that test over the
  persisted `team_score` stream is the substitute. The mocker authors the
  estimator's OUTPUT and can never exercise its input.

### Flag Events
```json
{ "event": "flags_init", "reason": "map_load|match_start|reset|tick", "flags": [
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
  them from the capture zone. Confirmed by an in-zone count drop within a 5-poll
  (~2.5s) window against a rolling baseline, via a per-flag FIFO queue of pending
  killers: the engine applies the death decrement to the zone counts 0.2–2.5s
  (p50 ~1.1s) AFTER the kill (prod-measured 2026-07-06,
  `e2e/repro/cap-break-replay.cjs` — the original one-shot next-poll confirm
  caught <20% of real breaks, ~1 per 2700 kills). `breaker_id` is the killer
  (credited `cap_breaks`); `broke_team` is the capping team that lost the capper.
  The only per-player-attributable break in extension mode (counts only, no zone
  identity) — step-off / enemy-contest are `flag_cap_stopped`
  / `flag_cap_contested`, unattributed.

- **Candidacy is decided by TWO gates, and the count-drop is neither.** The drop
  only ever proves *somebody* left the zone. A killer is queued only if, at the
  moment of the kill, (1) the victim's team is capturing that point per a **live**
  `CA_is_capturing`/`CA_capturing_team` read — never `g_flag_capping_team[]`,
  which the 0.5s zone poll writes and which used to drop every kill in the first
  half-second of a capture — and (2) the victim died **inside that point's
  capture zone**. Without the second gate a kill anywhere on the map entered the
  FIFO and could steal a break caused by a real on-point death seconds later;
  such a credit is always wrong, since an off-point death cannot itself decrement
  the zone count. The closest qualifying point wins, because zones overlap. Both
  defects were found independently by Drew in `stats_logging.sma` (KTPAMXX
  #24/#25), which runs the same design against the league stats DB — keep the two
  in step or the overlay and the DB will disagree about the same play.

- **Containment, NOT a radius — and the radius could never have been tuned into
  correctness.** The flag prop and its `dod_capture_area` trigger are separate
  entities and are **not co-located**: across the pool some control points sit
  entirely *outside* their own zone, and `dod_jagd`'s prop is thousands of units
  from its trigger. So any single radius is simultaneously too small on one map
  and far too large on another, and no value fixes both. The pool is also in
  flux, so a constant tuned to today's maps stops being valid the moment a swap
  lands — silently. Reached independently upstream in **KTPAMXX PR #49**, which
  makes the same argument against the same approach in `stats_logging`.

- **Box-vs-box, not point-in-box.** GoldSrc decides trigger membership by bbox
  overlap, so testing whether the victim's *origin* is inside the zone rejects
  players the engine itself counted as in it — under-counting in a new way while
  looking stricter. The player box also tracks stance, so a prone player is the
  flatter volume the engine actually uses, which is exactly the case decided at a
  zone edge.

- **Needs `dodx_area_get_bounds` / `dodx_get_user_bounds`** (added by our KTPAMXX
  PR, `pEdict->v.absmin/absmax` straight from the HL SDK, extension-mode safe).
  Bound optionally via `plugin_natives`/`set_native_filter` as ONE flag —
  a half-bound pair would mix a contained zone test with a point-origin victim.
  **The obvious alternative, fakemeta's `pev(ent, pev_absmin)`, is barred**:
  `fakemeta.inc` carries `#pragma reqlib fakemeta`, and the fleet's `modules.ini`
  lists only `reapi`/`dodx`/`amxxcurl` with no fakemeta module shipped at all, so
  a plugin including it does not LOAD — a whole-plugin outage, not a lost stat.

- **`CAP_BREAK_RADIUS` (768) survives as a FALLBACK ONLY**, for a dodx without
  the bounds natives, so a module rollback degrades to the previous behaviour
  rather than reporting zero cap breaks. **Do not tune it** — the approach is
  wrong, not the number. It was measured (`scripts/cap-radius-check.py` walks BSP
  lump 14 for each `dod_capture_area`'s furthest horizontal corner from its CP;
  seven pool maps exceed the 512 `stats_logging` used, peak `dod_saints2_b3e`
  669), and measuring it correctly is precisely what showed the approach could
  not work: `dod_jagd` came out at 5646.

#### Flag ownership resets (map start / round restart)

`flags_init` is a **full-state snapshot**, re-emitted throughout the map — not once
per map load. `reason` says how far to trust it:

| reason | when | frontend |
|---|---|---|
| `map_load` | `controlpoints_init` + `task_init_config` | authoritative |
| `match_start` | `ktp_match_start` | authoritative |
| `reset` | debounced after a round-restart cascade | authoritative |
| `tick` | the 30s `task_emit_flags` heartbeat | conservative |

Authoritative snapshots are adopted verbatim, **neutrals included**; a `tick` keeps
the older "never downgrade a captured flag to neutral" rule so a heartbeat landing
mid-restart can't grey out the bar (`4caaa75`). Guarded by the `flags-init-reason`
invariant — an untagged or misspelled reason silently degrades to conservative,
which is the bug, not a crash.

Three things had to line up for ownership to reset correctly; all three were broken:

- **Map defaults.** The engine only broadcasts `SetObj` when a CP *changes hands*,
  and dodx's pdata `owner` read is a misaligned field that is 0 for every CP. So on
  a map with default-owned flags (`dod_donner`, `dod_kalt`, `dod_flash`,
  `dod_saints2_*`) every flag read neutral for the whole map — a round restart did
  **not** heal it (verified locally: `sv_restartround` produced no CP forwards).
  Fixed in dodx by parsing `point_default_owner` out of the BSP entity lump in
  `DODX_InitCPFromEntities`, which also makes `CP_default_owner` real.
- **Neutral resets were never announced.** `dod_control_point_captured` swallows
  team→neutral transitions (a live flag never goes neutral mid-round, so they are
  all restart noise) — but it emitted nothing in their place, so the frontend never
  learned. The first reset marker now arms a short window and schedules one
  `reason:"reset"` snapshot carrying the whole post-restart state.
- **Team resets looked like captures.** On default-owned maps the same cascade
  restores flags to allies/axis, which alone is indistinguishable from a capture.
  Inside the reset window a transition landing exactly on the flag's
  `CP_default_owner` is treated as cascade, not capture; and `deferred_emit_cap`
  drops a non-capout emission if a reset was detected after it was armed, since the
  engine can dispatch the neutral sibling a frame later than the flag itself. A
  capout emission is never dropped — that is the round-winning cap, and the restart
  it causes necessarily lands inside the same window. (A cascade can't produce a
  capout: that needs every flag on the map defaulting to one team.)

  **Residual, deliberate:** a cascade that resets *only* home flags has no neutral
  sibling to open the window, so its one transition still emits a phantom capture.
  It is recognisable — lands on the default, `dod_score_event` credited nobody — but
  not reliably: a genuine home-flag re-capture looks identical on the one occasion
  its score event goes missing. So that evidence only schedules the snapshot (the
  bar ends correct either way, which is the bug) and still emits. Losing a capture
  the casters just watched is worse than one stray feed line at a round boundary.

The reset window arms **once** per cascade and extends in place. Re-arming with
`remove_task` + `set_task` per flag loses the last arm — and therefore the whole
snapshot — to the KTPAMXX shared-SP-forward hazard, since a real cascade dispatches
every CP in one frame.

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
  connect/disconnect). Assist = 50+ *applied* enemy damage to a victim since their last spawn,
  killed by someone else. `kill_class` "nade" = wpnindex ∈ {13,14,15,16,36} (grenades + mills bomb).
  `cap_breaks` = defensive stat: killed an enemy capper standing on the point (separate
  from `caps`, which is offensive). Credited via the breaker's `player_score`.
- **Go-live re-wipe (mass-respawn burst).** `ktp_match_start` — and therefore the
  HUD's stat wipe — fires at the **START** of the go-live `mp_clan_timer` countdown
  (~10s), but the engine only zeroes frags at its **END**, when
  `mp_clan_restartround` actually restarts the round. Because the HUD counts kills
  unconditionally (`client_death` has no live gate), every kill during that ~10s
  countdown is kept by the HUD and wiped by the engine, leaving the overlay
  permanently above the in-game scoreboard for the rest of the half (prod-measured
  2026-07-19 on `1784509712-ATL1`: 4 countdown kills → 6 player-visible K/D deltas).
  **`RoundState==1` cannot be used to detect that edge — the DoD engine never emits
  it on prod** (KTPMatchHandler times out on the same signal every match). The plugin
  instead re-wipes on the engine's own **mass-respawn burst**: ≥8 `dod_client_spawn`
  within 1.5s while armed (mid-countdown respawn waves are only 2–3 players, so they
  can't trip it), with a `set_task(mp_clan_timer + 2s)` fallback for rosters too small
  to burst. Single-shot per half and idempotent — the burst, the fallback, and a
  `RoundState==1` (on configs that do emit it) all route through
  `do_golive_stat_rewipe()`, first one wins. Gated by `g_awaiting_stat_rewipe`, kept
  deliberately **separate** from `g_awaiting_round_live`, which the half-clock reads as
  its go-live window and must keep armed for its full deadline.
- **Teamkills and suicides score nothing — never decrement.** DoD applies **no frag
  penalty** for a TK or a suicide, so the HUD must not either. The plugin used to do
  `g_player_kills[killer]--` on a TK, which put the overlay permanently *below* the
  real scoreboard for anyone who TK'd (prod-verified 2026-07-19: a mid-half TK left
  the in-game scoreboard at 11 kills vs the HUD's 10). TK-victim deaths **do** count on
  both sides. The teamkill itself is still tracked via `g_player_teamkills` and
  surfaced in the kill feed (`killer_tk_count`).
- **Summary team source.** `emit_stats_summary` filters players by the plugin-tracked
  `g_player_team[]`, NOT the live `get_user_team(id)`: at the end-of-match intermission
  the engine team read returns non-ALLIES/AXIS for everyone, which silently emptied the
  `match_end` board (confirmed on `1783044529-ATL1`). Guarded by the
  `summary-roster-nonempty` event invariant.
- `half_end` + a `half_end`-reason summary fire when the plugin sees KTPMatchHandler's
  `KTP_HALF_END` log line (half-1 end only); `ktp_match_end` covers all terminal paths.
- Summary emission is event-driven only (cap / capout / half end / match end /
  rcon `amx_hud_statsboard`) — never from repeating tasks (half-1 wedge immunity).
- Frontend boards: render-time TTL by reason (`hud.json` settings), dismissed when the
  next half goes live; match-end board sums the cached half-1 summary with final-half
  rows for full-match totals.

---

## Caster Page (`/caster`)

`/caster?server=<X-Server-Hostname>` — the **persistent** counterpart to the transient
on-air StatsBoard popup, for a caster's second monitor. Not an OBS source; never
composited into the broadcast.

- **Broadcast-synced, not real-time.** Joins the same delayed `server:<host>` room as
  `/screen`, so the numbers match the video casters and viewers are watching. There is
  no undelayed socket path (the HLTV delay is applied backend-side before any emit).
- **Reuses, doesn't duplicate**: `SocketStoreComponent` + `useHudStore` (same store,
  own tab → own socket), `StatsTable`, `Flags`, `Timer`, `getWeaponIcon`.
- **Scope toggle** — `This Half` / each completed half / `MATCH`. Halves come from the
  `halfRows` carry archive in Socket.jsx via `getHalfRows` / `getRecordedHalves` /
  `carrySoFar` (module-level, polled on a 1s tick — deliberately NOT mirrored into the
  store, which would put the on-air cumulative-stats state machine on the render path).
- **MATCH groups each player under their CURRENT-half side**, since teams swap at
  halftime and `addStatRows` keeps the latest team. Same as the on-air `match_end`
  board; correct for 6v6 with fixed rosters.
- **Freeze** snapshots the table so a caster can read it mid-firefight; the feed keeps
  running underneath and an unmissable banner marks it stale.
- **Known prototype limit**: a reload after half 2 goes live loses half-1 carry — the
  backend evicts its cached `halftime_summary` at `half_start` (`ingest.ts`), so the
  join snapshot has nothing to replay. The page detects this and shows
  `⚠ opened after halftime`. The durable fix (a `half_archive` on `ServerState` that
  survives `half_start`) would also fix a latent on-air bug: an OBS browser-source
  reload during half 2 makes the `FINAL STATS` board show half-2 numbers only.
- **Moments panel** (`MomentsPanel.jsx`) — three things the scoreboard cannot
  show, each a sentence a caster can say out loud: **shutdowns** (who ended a
  streak of 3+, and how long it was), **bursts** (fastest multi-kill, gap ≤5s),
  and **cap setups** (kills by the capturing side in the 30s before their flag).
  Half-scoped; clears with `kill_streaks`.
  - **Accumulated in the store (`derived` slice), NOT derived at render from
    `kill_log`** — that slice is capped at 150 entries and a long half can exceed
    it, which would silently turn a half-scoped panel into a moving window.
  - **A shutdown needs the victim's streak read BEFORE `addKill` resets it.**
    Nothing else on the entry carries the pre-death value; the entry now also
    stamps `victim_streak` so a consumer can see why one was credited.
  - **A burst ends when the killer DIES, not on the clock.** Dying resets the
    streak, so the next kill lands on streak 1 — that, plus the gap, is the
    continuation test. `chain_run` holds the in-progress burst; `derived.chains`
    holds the best one.
  - **Teamkills and suicides credit nothing anywhere here**, matching the
    plugin's rule that they never score.
  - **Deliberately NOT a composite score.** Krod's accumulation weights
    ("bounded v3") are unpushed local work — only the shapes are public — so a
    number invented here would be a third scoring system on air alongside KTPR
    and accumulation, disagreeing with both. Add the composite only once we can
    mirror his constants. Contract pinned by `Socket.moments.test.js`.

- **Do NOT add `gameEvents.on(...)` listeners from this page** — `SocketStoreComponent`'s
  effect cleanup calls `gameEvents.removeAllListeners()`, which wipes every listener
  globally, and `index.jsx` mounts under StrictMode (effects run mount→unmount→mount in
  dev). Extend the store instead; that's why the deep kill history is a `kill_log`
  slice rather than a direct subscription.

---

## League Stats Database (KTPHLStatsX read layer)

`backend/src/statsdb/` is a **read-only** client for the league's MySQL `hlstatsx`
database — Krod's (andsmit9 / Drew) pipeline: `stats_logging.amxx` →
`logaddress_add` UDP → the KTPHLStatsX Perl daemon → MySQL. That pipeline is
entirely **post-match**; our overlay is the only real-time surface in the
ecosystem, so this layer exists to put *history* next to the live match, never to
drive anything on air.

**Nothing in this repo may write to that database.** `assertReadOnly` re-checks
every statement at call time, the configured user is expected to hold SELECT
only, and there is no write path. The two pipelines are deliberately **not**
consolidated at the producer: ours is a low-latency HTTP feed behind an HLTV
delay buffer, theirs is a durable UDP ledger, and merging them would couple an
on-air dependency to a stats deploy cadence.

- **Disabled by default** (`stats_db.enabled: false`), including in production
  until a SELECT-only MySQL user exists on the data server. Every accessor
  returns `null`/`[]` when off and the REST layer answers **503**, so a dev
  laptop and CI degrade instead of throwing.
- **Routes** (all inline in `app.ts`, all read-only): `/api/stats/matches`,
  `/api/stats/matches/:matchId`, `/api/stats/players/:steamId`,
  `/api/stats/players?ids=` (batch), `/api/stats/maps/:mapName/flags`, and
  `/api/stats/_guard` for breaker diagnostics.
### Publishing policy (league rules, not preferences)

Set by the stats owner (Krod, 2026-08-24). Both are the kind of rule obeyed on
the day it is written and quietly broken later by an unrelated change, so both
are pinned by tests in `statsDb.test.ts`, not just documented here.

- **12-man stats must not be surfaced.** Enforced as an **allowlist**,
  `OFFICIAL_MATCH_TYPES = [0, 4]` (official + official OT), applied to every
  query that can reach player stats. A blocklist would surface any type added
  later by default, and the cost of that mistake is publishing exactly what we
  were asked not to.
  - **NULL is excluded, and in production that currently means EVERYTHING is.**
    `ktp_matches.match_type` is NULL on all 3,766 prod rows (1,981 matches) —
    the HLStatsX daemon never populates it, despite the column carrying the enum
    in its comment and an `idx_retention(match_type, start_time)` index. So the
    read layer returns nothing against prod today. That is the correct answer,
    not a bug to route around. Filed as **KTPHLStatsX #37**.
  - **Never rewrite the filter as `NOT IN (2)`, `!= 2`, or add
    `OR match_type IS NULL`.** The first two also drop every NULL row — the
    right result for the wrong reason — and start leaking the moment the column
    is populated. The third restores the leak outright. All three are guarded.

- **Per-player location and heatmap data must not be surfaced.** Position
  samples deliberately have **NO REST route**; `positionSamples()` exists for
  possible future server-side use only, and a test asserts `app.ts` never
  references it. Static per-map **flag** coordinates stay allowed — that is map
  geometry, identical for everyone, not player movement.

### Load protection (`statsdb/guard.ts`)

The data server also runs MySQL for the league, the HLStatsX daemon, the HLTV
proxies and this backend, and these endpoints are **public and unauthenticated**.
Seven layers, in order: enabled check → per-IP rate limit (60/min) → TTL cache →
concurrency cap (4) → circuit breaker → MySQL-side `MAX_EXECUTION_TIME(2000)` →
client timeout. Two properties are load-bearing:

- **The breaker trips on SLOW SUCCESSES, not only errors** (`slowCallMs` 750).
  A database that is merely struggling is exactly the case worth backing off
  from, and it never raises an error on its own.
- **`MAX_EXECUTION_TIME` is the layer that actually protects the server.** A
  client timeout only stops *us* waiting; MySQL keeps working. The hint makes the
  database kill its own statement (error 3024), and it holds even if this process
  wedges or leaks a connection.

**The two 503s must be told apart by the client, and the body is what says
which.** `reason: "disabled"` is permanent (no database configured — the
production default today) and a caller should stop asking; `reason: "shedding"`
is transient by construction, because the breaker half-opens on its own and the
concurrency cap clears as soon as in-flight queries finish. A client that
latches off for a shed defeats the entire mechanism — the panel stays dark for
the rest of a broadcast because the data server was briefly busy once. A 503
with no `reason` (older backend) is read as permanent, which is the safe
direction.

**Clients must also let the roster SETTLE before asking.** Players connect one
at a time, so a filling 12-man changes the id set twelve times in about a
second; without a debounce that is twelve requests in a burst, which trips the
concurrency cap and gets them shed at exactly the moment the panel first has
something to show. Measured against the local stack before the fix: 8 shed
requests on a single mocker run. `useCareerStats` waits 750ms.

Shed requests answer **503 with Retry-After** and never touch MySQL. `undefined`
from the work function means **404** (no such player) — distinct from 502 (query
failed) and 503 (stand down), so a caller can tell "unknown" from "ask later".

### Batch career reads

`GET /api/stats/players?ids=a,b,c` is the form the caster page uses: a full
roster is **one** query, one cache entry and one rate-limit token instead of
twelve. Capped at `MAX_CAREER_BATCH` (24) and ids are sorted server-side so two
clients with the same roster share the cache entry. **Absent ids are not an
error** — the reply is a map and a missing key means "no league match recorded",
which the UI renders differently from a zero.

### Traps inherited from KTPHLStatsX's own README

Each of these produces a plausible wrong answer rather than an error:

- **`half` means two different things.** On `ktp_match_stats`, `half = 0` is the
  stored match TOTAL; on the `hlstats_Events_*` tables the same value means the
  daemon held no match context (warmup). Summing `ktp_match_stats` without a
  half filter double-counts everything.
- **`ktp_matches` holds one row PER HALF**, so a recent-match list must group or
  a two-half match appears twice (OT, three times).
- **Collation.** `hlstats_Events_*` are `utf8mb4_unicode_ci`, `ktp_*` are
  `utf8mb4_0900_ai_ci`; joining `match_id` across the two families without an
  explicit COLLATE raises "Illegal mix of collations".
- **SteamID format.** `hlstats_PlayerUniqueIds.uniqueId` is `1:748805` with no
  `STEAM_0:` prefix. Cross the boundary with `toHlstatsUniqueId`/`toHudSteamId`;
  comparing the raw forms silently matches nothing.
- **Receipt vs producer time.** Rows are stamped when the daemon receives them.
  Timed analytics belong on `producer_match_id` / `producer_half` / `event_epoch`.
- **Aggregates arrive as STRINGS** (DECIMAL/BIGINT under `bigNumberStrings`), so
  an uncoerced career row serialises as `"kills": "70"` and `kills + 1` gives
  `"701"`. `toNumbers` + `CAREER_NUMERIC` handle it centrally.

### Local database (`data-server/sql/`)

`start.sh` creates the `hlstatsx` DB, a SELECT-only user, then applies
`01-schema.sql` and `02-fixture.sql` on **every** boot (idempotent), so anyone who
starts the KTPInfrastructure stack gets a working read layer with no setup. Both
files are **local-only and must never be applied to production** — the schema is a
minimal subset of the tables we read, and the fixture is **synthetic**: invented
players, no real player data.

The fixture is shaped to exercise the traps rather than to look realistic: a
`half = 0` TOTAL that sums exactly to its halves, one in-progress match with no
TOTAL row (so those players correctly read as *no league record*), one match with
`damage = 0` (reproducing KTPHLStatsX issue #33), an apostrophe in a name, and
`flag_index` in dodx spawn order.

**Its uniqueIds deliberately match the mocker's roster** (`STEAM_0:0:1001-1006`
allies, `2001-2006` axis, minus the `STEAM_0:` prefix). That alignment is what
makes the whole chain testable on one machine — run the mocker and every player on
`/caster` has a career row. Break it and the panel goes correctly but uselessly
blank, which is indistinguishable from the read layer being broken.

### League Career panel (`/caster`)

`web/src/components/caster/CareerPanel.jsx` + `useCareerStats.js` — the first
surface that reads the stats DB rather than the socket feed. Two rules:

- **It must disappear when the database is off.** `useCareerStats` reports
  `unavailable` for both "not configured" and "shedding load", latches that state
  so it stops polling, and the panel renders `null`. A permanently empty panel on
  a caster's monitor reads as a broken page, not as a switched-off feature.
- **It must never reach `/screen`.** These numbers are historical and refresh at
  most every 5 minutes; an on-air overlay that depends on a MySQL query goes blank
  when the data server is busy.

Rows are labelled from the LIVE roster and joined on SteamID, so a player who has
since changed their in-game name still matches. Contract pinned by
`useCareerStats.test.js`.

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
- [web/src/components/core/Socket/Socket.waves.test.js](web/src/components/core/Socket/Socket.waves.test.js) — reinforcement-wave clock store contract: both-sides anchoring with a receipt stamp, one-sided block nulls the other side (no stale countdown), missing `waves` key clears both, applied on an empty/malformed `players` array, `pending` defaults, half + fresh-match boundary clears

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
- **Single server (canary / enable, e.g. Denver 5 only)**: `./deploy/deploy-plugin.sh cadaver@<server-ip> dod-<port>` pushes + restarts one server; add `--bootstrap` for a first-time install (it writes the `KTPHudObserver.amxx` line under the "Custom - Add 3rd party plugins" section of `configs/plugins.ini` + the `hud_observer.cfg` exec line, then restarts). The line carries **no `debug` flag** — AMXX clears `AMX_FLAG_JITC` globally the moment any plugin loads with one, killing the JIT for every plugin on that server; `--bootstrap` also strips it from servers bootstrapped before 2026-08-23, when the script still wrote it. This is the path for canarying a new build on ONE server before `distribute-plugin.sh` fans it out, and for enabling/disabling the HUD on a given server.

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
- `backend/src/handler/hqBoard.ts` — `/api/hq` projection for the HQ board (see above)
- `backend/src/handler/serverList.ts` — `/api/servers` projection: fleet ordering + HLTV connect pairing for `/watch` (see above)
- `backend/src/config.ts` — YAML config loader with env-var overrides
- `backend/src/socket/socket.ts` — Socket.IO rooms (matchId-keyed)
- `backend/src/app.ts` — **all** REST routes, defined inline (there is no
  `routes/apiRouter.ts`; the only `Router()` in the repo is `createIngestRouter`)
- `web/src/components/core/Socket/Socket.jsx` — all game state logic (Zustand store + event handlers)
- `web/src/components/hq/` — HQ operations board (`/hq`); polls REST, never imports Socket.jsx
- `web/src/components/matchPicker/MatchPicker.jsx` — `/watch` server & match picker (HLTV connect links)
- `web/src/components/screen/api/api.js` — weapon name → display info mapping
- `web/src/components/screen/Example.jsx` — main HUD layout
- `web/src/components/core/StatsBoard/StatsTable.jsx` — the per-team stat table, shared by the on-air board and the caster page
- `web/src/components/caster/Caster.jsx` — caster reference page (`/caster`, see below)
- `config/local/config.yaml` — local-dev backend config (committed; ports, auth key, storage). Production uses `config/online/config.yaml` (gitignored, operator-owned), selected via `HUD_CONFIG_PATH` env var. Template: `config/online/config.yaml.example`.
- `data-server/Dockerfile` — build source for the KTPInfrastructure data container
- `dod_hud_observer.sma` — legacy plugin (vanilla Metamod version, kept for reference)
