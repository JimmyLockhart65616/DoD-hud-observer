# KTP Migration Plan

**Status:** Approved 2026-04-10. Implementation in progress — see [KTP_MIGRATION_PROGRESS.md](KTP_MIGRATION_PROGRESS.md).

## Context

The DoD HUD Observer pivots from vanilla HLDS + Metamod-P to the KTP competitive
infrastructure stack (by `afraznein`). KTP eliminates Metamod entirely (wall-penetration
bug on ReHLDS+Metamod+DoD) and runs KTPAMXX as a ReHLDS extension. This invalidates our
current `fakemeta`/`sockets`/`dodfun` dependencies — we must rewrite the plugin around
DODX natives/forwards, KTPAMXXCurl for transport, and the KTPMatchHandler forwards for
match lifecycle.

## Decisions (locked 2026-04-10)

| # | Decision | Value |
| - | -------- | ----- |
| 1 | Plugin rename | `dod_hud_observer.sma` → `KTPHudObserver.sma` / `KTPHudObserver.amxx` |
| 2 | Transport | Per-event HTTP POST via KTPAMXXCurl; monitor throughput, add batching only if perf demands it |
| 3 | Backend ports | `8088` HTTP ingest, `3000` React frontend on `74.91.112.242` |
| 4 | Auth | `X-Auth-Key` header (reuse KTPHLTVRecorder pattern) |
| 5 | KTPInfrastructure | Work directly upstream on `afraznein/KTPInfrastructure` (commit access TBD) |
| 6 | Match storage | `events.jsonl` + `metadata.json` per match, co-located with HLTV demo files, keyed by `matchId` |
| 7 | Phase order | Local first (Option A rebuild), then backend, then plugin. No live testing until local validates. |

**Production target server:** Denver 5 (`cadaver@66.163.114.109`)
**Backend host:** `74.91.112.242` (co-located with HLStatsX + `hltv-api.py`)
**Match ID format:** `KTP-{timestamp}-{map}-{hostname}`

## Architecture (target)

```text
KTP-ReHLDS
  └─ KTPAMXX (ReHLDS extension — NO Metamod)
       ├─ dodx_ktp        (cap zones, prone, spawn, death, team/class)
       ├─ reapi_ktp       (entity helpers)
       ├─ amxxcurl_ktp    (async HTTP POST transport)
       └─ KTPHudObserver.amxx
            ├─ hooks ktp_match_start / ktp_match_end (from KTPMatchHandler)
            ├─ builds curl_slist headers ONCE in plugin_init (v1.5.1 segfault fix)
            └─ POSTs JSON events to backend with X-Auth-Key

Backend (74.91.112.242, systemd)
  ├─ Express HTTP ingest :8088 (X-Auth-Key verification)
  ├─ MatchRecorder → events.jsonl + metadata.json per matchId
  ├─ Socket.IO rooms keyed by matchId
  └─ Static React frontend :3000 (URL-driven match selection)

KTPFileDistributor
  └─ drops compiled KTPHudObserver.amxx into /home/dod/distribute/ → SFTP to fleet

KTPInfrastructure
  ├─ build/plugins/Dockerfile — add KTPHudObserver to compile list
  ├─ config.yaml              — add plugins/KTPHudObserver.amxx to paths.plugins
  └─ Makefile                 — (optional) deploy-hud-observer target
```

## Test Environment (`docker-compose.yml`)

Mirrors production topology: game servers stream three independent paths to a data server.

```text
┌──────────────────────┐  ┌──────────────────────┐
│  ktp-game-1          │  │  ktp-game-2          │
│  KTP-ReHLDS + AMXX   │  │  KTP-ReHLDS + AMXX   │
│  dod_anzio           │  │  dod_flash           │
│  :27016 (game)       │  │  :27017 (game)       │
│                      │  │                      │
│  ┌─ HLTV ──────► data-hltv-1 (:27020)         │
│  ├─ log_address ─► data-hlstatsx (UDP :27500)  │
│  └─ curl POST ──► data-backend (:8088)         │
│                      │  │                      │
│  (same 3 paths) ─────┼──┼─► data-hltv-2, etc.  │
└──────────────────────┘  └──────────────────────┘
                               │
                    ┌──────────▼───────────────┐
                    │  Data server cluster     │
                    │  ├─ data-hltv-1 (:27020) │
                    │  ├─ data-hltv-2 (:27021) │
                    │  ├─ data-hlstatsx (stub)  │
                    │  ├─ data-mysql (:3306)    │
                    │  ├─ data-backend          │
                    │  │  ├─ :8088 ingest       │
                    │  │  ├─ :3001 REST API     │
                    │  │  └─ :4000 Socket.IO    │
                    │  └─ data-frontend (:3000) │
                    └──────────────────────────┘
```

### Per-server config layout

```text
test-env/
├── game-1/server.cfg     # hostname, log_address_add → data-hlstatsx:27500
├── game-2/server.cfg     # same structure, different hostname + map
└── data/
    ├── hltv-1.cfg         # connect ktp-game-1:27015
    ├── hltv-2.cfg         # connect ktp-game-2:27015
    └── demos/             # HLTV demo recordings (shared volume)
```

Game servers share artifacts from `../KTPInfrastructure/artifacts/latest/` (engine binaries,
KTPAMXX, plugins) — same binary set, different configs. This mirrors production where
KTPFileDistributor pushes identical files to all servers in a cluster.

## Phases

### Phase 0 — Local test environment rebuild (Option A)

**Goal:** Mirror KTPInfrastructure's Docker build locally so we can run KTP-ReHLDS +
KTPAMXX + DODX + ReAPI + KTPAMXXCurl + KTPMatchHandler + KTPHudObserver end-to-end without
touching a live server.

- P0.1 Fork/clone `afraznein/KTPInfrastructure` adjacent to this repo
- P0.2 Build all KTP images locally via `make build` (ktp-base → rehlds → amxx → reapi → curl)
- P0.3 Add a local `docker-compose.yml` that runs `ktp-rehlds` with `dod` mod,
       mounting compiled plugins + a minimal map rotation
- P0.4 Verify KTPMatchHandler loads and emits `ktp_match_start` via a scrim command
- P0.5 Retire `jives/hlds:dod` + Metamod-P test harness (keep as `docker-compose.legacy.yml`
       for reference, don't delete)
- P0.6 Production-mirror test environment (`docker-compose.yml`):
       2 game servers (dod_anzio, dod_flash) + data server cluster
       (2 HLTV proxies, HLStatsX stub, Node.js backend, React frontend)
- P0.7 Per-server configs in `test-env/` (server.cfg per game server,
       HLTV configs, HLStatsX log routing via `log_address_add`)
- P0.8 Backend Dockerfile for containerized data server
- P0.9 Bot support on KTP-ReHLDS (TBD — MarineBot requires Metamod's
       `localinfo mm_gamedll` which doesn't exist without Metamod.
       Investigate ReHLDS game DLL chaining or AMXX-based bot plugins)

### Phase 1 — Backend rewrite

**Goal:** HTTP ingest + match-aware recording + room-based Socket.IO fan-out.

- P1.1 Replace `backend/src/handler/server.ts` (`PluginServer` TCP listener) with an Express
       POST route `/ingest` that validates `X-Auth-Key`
- P1.2 Add `MatchRecorder` class: on first event with a new `match_id`, create
       `matches/{matchId}/events.jsonl` + `metadata.json`; append every event; finalize
       on `ktp_match_end`
- P1.3 Socket.IO rooms keyed by `matchId`; frontend joins a room via URL param
- P1.4 Convert `config.json` → `config.yaml` (match KTPInfrastructure conventions);
       env-var overrides for secrets (`HUD_AUTH_KEY`, `HUD_INGEST_PORT`)
- P1.5 Basic health endpoint at `/metrics`: EPS counter (events per second),
       per-server breakdown (keyed by source game server IP or hostname)
- P1.6 Jest tests for ingest auth, MatchRecorder lifecycle, room routing

### Phase 2 — Plugin rewrite (`KTPHudObserver.sma`)

**Goal:** Remove fakemeta/sockets/dodfun; use DODX + ReAPI + KTPAMXXCurl only.

- P2.1 Rename source; remove `#include <fakemeta>`, `<sockets>`, `<dodfun>`;
       add `<curl>`, `<dodx>`, `<reapi>`, `<reapi_engine>`
- P2.2 Replace socket reconnect state machine with curl POST helper:
       - Build `curl_slist` headers ONCE in `plugin_init` (Content-Type, X-Auth-Key)
       - `post_event(json[])` → `curl_easy_init` → `CURLOPT_URL` / `CURLOPT_HTTPHEADER` /
         `CURLOPT_COPYPOSTFIELDS` / `CURLOPT_TIMEOUT` (1000ms) → `curl_easy_perform`
         with callback → `curl_easy_cleanup` in callback
       - On timeout: log warning to server console, discard the event, move on.
         Sustained timeouts in the logs = backlog. Next step would be batching.
- P2.3 Replace fakemeta cap zone scan (`EngFunc_FindEntityByString` + `pev_absmin/max`)
       with DODX: hook `controlpoints_init`, use `dodx_area_get_data(idx, CA_*)` for
       cap progress, hook `dod_control_point_captured` for flag capture events
- P2.4 Hook `ktp_match_start(matchId[], map[], matchType, half)` and `ktp_match_end(...)`;
       stamp every emitted event with `match_id`, `match_type`, `half`;
       remove our ad-hoc half counter
- P2.5 Port prone/spawn/death/team-change/class-change from fakemeta hooks to DODX forwards
       (`dod_client_prone`, `dod_client_spawn`, `client_death`, `dod_client_changeteam`, etc.)
- P2.6 Compile via KTPInfrastructure Docker: add to `build/plugins/Dockerfile` compile
       list + source `COPY`

### Phase 3 — Frontend match awareness

**Goal:** Frontend can tune into any live match or replay a stored one.

- P3.1 URL schema: `/screen?match={matchId}` joins that Socket.IO room
- P3.2 Match picker page listing recent matches from backend REST
- P3.3 Replay mode: fetch `events.jsonl` for a match, replay with `tick` field timing
       (stepping stone for future HLTV demo sync)

### Phase 4 — Deployment (NOT STARTED until Phase 0–3 validated locally)

- P4.1 systemd unit on `74.91.112.242` for backend; nginx or Express static for frontend
- P4.2 Firewall: open 8088 (ingest) from fleet IPs only, 3000 (frontend) publicly
- P4.3 KTPInfrastructure PR: add `KTPHudObserver` to `build/plugins/Dockerfile` + `config.yaml`
- P4.4 KTPFileDistributor: drop compiled `.amxx` into `/home/dod/distribute/`
- P4.5 Smoke test on Denver 5 first, then roll to other test clusters

### Phase 5 — Match storage co-location with HLTV demos

- P5.1 Align match storage directory with KTPHLTVRecorder's demo output path (TBD — need
       to confirm where HLTV recorder drops `.dem` files on the data server)
- P5.2 Match lookup API resolves `matchId` → `{events.jsonl, metadata.json, demo.dem}`

## Open items

- Is `sockets_amxx` truly unavailable under KTPAMXX extension mode? (Confirmed: not in
  `modules/` on Denver 5. Curl is the path.)
- Where does KTPHLTVRecorder write `.dem` files on the data server? Need path for Phase 5.
- KTPInfrastructure commit access — user to coordinate with `afraznein`.
- Load testing: what EPS does a 6v6 competitive match actually produce? Decides batching question.

## Non-goals / de-scoped

- No British team (Allies vs Axis only).
- No HLTV demo replay overlay yet (designed in [project_hltv_replay_design.md], future work).
- No touching the live Denver 5 server until Phase 0–3 pass locally end-to-end.
- No economy/money/C4 events (DoD has none).
