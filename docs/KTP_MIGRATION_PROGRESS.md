# KTP Migration Progress

Companion to [KTP_MIGRATION_PLAN.md](KTP_MIGRATION_PLAN.md). Update as work completes
across sessions. Mark tasks `[x]` done, `[~]` in progress, `[ ]` not started. Add a
dated note on every status change.

**Current session focus:** Phase 3 complete, server picker added, docker cleanup.

---

## Phase 0 — Local test environment rebuild

- [x] P0.1 Clone `afraznein/KTPInfrastructure` + sibling KTP repos to `d:/Git/` (2026-04-11)
- [x] P0.1b Add cloned repos to VS Code workspace (2026-04-11)
- [x] P0.2 Build all KTP images locally (2026-04-12) — 3 Dockerfile patches needed (see upstream PRs)
- [x] P0.3 Single-server KTP-ReHLDS test via `docker-compose.ktp.yml` (2026-04-12) — superseded by P0.6
- [x] P0.4 KTPMatchHandler loads, registers ktp_match_start/end forwards (2026-04-12)
- [x] P0.5 Renamed original `docker-compose.yml` → `docker-compose.legacy.yml` (2026-04-12)
- [x] P0.6 Production-mirror `docker-compose.yml`: 2 game servers + data server cluster (2026-04-12)
- [x] P0.7 Per-server configs in `test-env/` (server.cfg, HLTV configs, log routing) (2026-04-12)
- [x] P0.8 Backend Dockerfile for containerized data server (2026-04-12)
- [~] P0.9 Bot support on KTP-ReHLDS — **not feasible**. Metamod-P incompatible with KTP-ReHLDS (garbled LoadLibrary crash). No fakemeta module compiled for KTPAMXX. ReAPI doesn't expose CreateFakeClient. Workaround: use `.override_ready_limits` chat command (KTPMatchHandler built-in, reduces to 1 player per team) + connect with DoD client for solo testing. Bots deferred indefinitely. (2026-04-14)

## Phase 1 — Backend rewrite

- [x] P1.1 Replace `PluginServer` TCP listener with Express `/ingest` POST + `X-Auth-Key` (2026-04-13)
- [x] P1.2 `MatchRecorder` class: `events.jsonl` + `metadata.json` per matchId (2026-04-13)
- [x] P1.3 Socket.IO rooms keyed by matchId; `join_match`, `leave_match`, `list_matches` events (2026-04-13)
- [x] P1.4 `config.json` → `config.yaml`; env-var overrides (`HUD_AUTH_KEY`, `HUD_INGEST_PORT`, etc.) (2026-04-13)
- [x] P1.5 `/metrics` endpoint: EPS counter, per-source breakdown, `X-Plugin-Sent-At` latency (2026-04-13)
- [x] P1.6 Jest tests — 20/20 passing: ingest auth, MatchRecorder lifecycle, match file I/O (2026-04-13)

## Phase 2 — Plugin rewrite (`KTPHudObserver.sma`)

- [x] P2.1 Rename + swap includes (drop fakemeta/sockets/dodfun; add curl/dodx) (2026-04-13)
- [x] P2.2 Curl POST helper with persistent `curl_slist` headers (2026-04-13)
- [x] P2.3 Replace cap zone scan with DODX `controlpoints_init` + `dod_control_point_captured` (2026-04-13)
- [x] P2.4 Hook `ktp_match_start`/`ktp_match_end`; stamp events with match metadata (2026-04-13)
- [x] P2.5 Port prone/spawn/death/team/class handlers to DODX forwards (2026-04-13)
- [ ] P2.6 Wire into KTPInfrastructure `build/plugins/Dockerfile` compile list

## Phase 3 — Frontend match awareness

- [x] P3.1 URL schema `/screen?match={matchId}` and `/screen?server={hostname}` → Socket.IO rooms (2026-04-14)
- [x] P3.2 Server + match picker page at `/watch` and `/matches` (2026-04-14)
- [x] P3.3 Replay mode via stored `events.jsonl` + `tick` field; `gameEvents` bus decouples Socket.IO from handlers (2026-04-14)

## Phase 4 — Deployment (blocked on Phase 0–3 local validation)

- [ ] P4.1 systemd unit on `74.91.112.242`
- [ ] P4.2 Firewall rules (8088 ingest fleet-only, 3000 public)
- [ ] P4.3 KTPInfrastructure upstream PR
- [ ] P4.4 KTPFileDistributor integration
- [ ] P4.5 Denver 5 smoke test

## Phase 5 — Match storage co-location with HLTV demos

- [ ] P5.1 Align match dir with HLTV `.dem` output path
- [ ] P5.2 Match lookup API joins events + demo

---

## Session log

### 2026-04-10

- Decisions locked (all 7 planning questions answered). Memory files saved.
- Plan + progress docs created at `docs/KTP_MIGRATION_PLAN.md` and `docs/KTP_MIGRATION_PROGRESS.md`.
- Next: start Phase 0 — clone KTPInfrastructure and run `make build` locally.

### 2026-04-11

- P0.1 cloned all KTP repos to `d:/Git/` as siblings. Initial clone used GitHub's
  repo names (`KTP-ReHLDS`, `KTP-ReAPI`, `KTPHLSDK`, `KTPAMXXCurl`) but the infra
  Dockerfiles `COPY` them under different names: `KTPReHLDS`, `KTPReAPI`, `KTPhlsdk`,
  `KTPAmxxCurl`. Re-cloned / renamed on disk to match Dockerfile expectations.
- `metamod-am` turned out to be `alliedmodders/metamod-hl1` cloned into a dir
  literally named `metamod-am` (per KTPAMXX/BUILD_INSTRUCTIONS_UBUNTU.md).
- KTPFileChecker access granted after user accepted collaborator invite. Cloned.
- Workspace file updated to the final 14 folders (all 13 KTP repos + metamod-am + this one).
- Kicked off `make build VERSION=localtest` in KTPInfrastructure. Running in background.
- `make` not on PATH → switched to direct `docker compose -f build/docker-compose.yml build`.
- `ktp-base:latest` built clean.
- `ktp-rehlds` failed: KTPReHLDS repo restructured (`build.sh` moved to root, artifact
  paths shifted). Patched Dockerfile locally (uncommitted). See upstream PRs section.
- `ktp-curl` failed: pinned `zlib-1.3.1` removed from zlib.net. Patched to `zlib-1.3.2`
  locally (uncommitted). See upstream PRs section.
- `ktp-rehlds:localtest` rebuilt successfully after patch.
- Now building amxx + reapi + curl in parallel in background (`b5hxfmdwb`).
- `ktp-amxx` failed: `amtl/am-vector.h` not found — KTPAMXX has a git submodule
  (`public/amtl` → `alliedmodders/amtl`) that wasn't initialized. Fixed with
  `git submodule update --init --recursive` in KTPAMXX. No Dockerfile change needed.
- Also missing `support/ambuild` (gitignored, not a submodule) — populated via
  `git clone alliedmodders/ambuild KTPAMXX/support/ambuild`. See upstream PRs section.
- Retrying amxx + reapi + curl build (`bxoredmdw`).

### 2026-04-12 (session 2)

- Cleaned up stopped Docker containers (old `hlds-1`, `hltv-1` from legacy compose).
- Designed production-mirror test topology: 2 game servers + data server cluster.
  Data server mirrors production: 2 HLTV proxies, HLStatsX log receiver, MySQL,
  Node.js backend, React frontend.
- Consolidated 7-service compose into 3 containers (mirroring production: 2 game servers +
  1 data server). Data server uses supervisord to run MySQL, 2 HLTV proxies, HLStatsX stub,
  Node.js backend, React frontend in a single container (`data-server/Dockerfile`).
- Created `test-env/` directory with per-server configs (server.cfg, HLTV configs).
  Game servers share artifacts from `../KTPInfrastructure/artifacts/latest/` (mirrors KTPFileDistributor).
- Curl backlog strategy simplified: 1000ms `CURLOPT_TIMEOUT` + log on timeout, discard
  event, move on. Sustained timeouts in server console = backlog signal.

### 2026-04-13 (session 3)

- Deleted `docker-compose.ktp.yml` (single-server prototype, superseded).
- Renamed `docker-compose.test.yml` → `docker-compose.yml` (now the default).
- `docker-compose.legacy.yml` kept for vanilla HLDS + Metamod-P reference.
- Updated CLAUDE.md: replaced stale vanilla Docker/compile sections with current
  KTP stack docs (3-container topology, `docker compose up`, updated compile command).
- Updated KTP_MIGRATION_PLAN.md and KTP_MIGRATION_PROGRESS.md to reflect renames.

### 2026-04-13 (session 4) — Phase 1 complete

- Replaced `PluginServer` TCP listener with HTTP ingest (P1.1). AMXX plugin now
  POSTs events via `KTPAMXXCurl` to `POST /ingest` with `X-Auth-Key` header.
  Two Express servers: ingest on `:8088` (firewall to game IPs in prod), REST on `:3001`.
- `MatchRecorder` (P1.2): per-match `events.jsonl` + `metadata.json` under `matches/`.
  Uses `appendFileSync` (synchronous) — avoids WriteStream buffering, correct for 6v6 rates.
- Socket.IO rooms (P1.3): `join_match`, `leave_match`, `join_all`, `list_matches`. Ingest
  route emits to `io.to(matchId)` and `io.to('all')` simultaneously.
- `config.yaml` (P1.4): replaces `config.json`. Env-var overrides for `HUD_AUTH_KEY`,
  `HUD_INGEST_PORT`, `HUD_API_PORT`, `HUD_SOCKET_PORT`, `HUD_MATCHES_DIR`, `HUD_FRONTEND_ORIGIN`.
- `/metrics` (P1.5): EPS counter (10-second rolling window), per-source breakdown,
  `X-Plugin-Sent-At` latency tracking.
- Jest tests (P1.6): 20/20 passing — ingest auth (401/400/200), MatchRecorder lifecycle
  (start/record/end), file I/O correctness. Added `supertest`, upgraded to `ts-jest@28`
  + `TypeScript@4` (required for ts-jest). Added `useUnknownInCatchVariables: false` to
  tsconfig to preserve pre-TS4.4 catch behavior in legacy `apiModel.ts`.
- Mocker updated (P1.7 bonus): HTTP mode (default, POST to `/ingest`) and Socket mode
  (`--socket` flag, direct emit for frontend-only dev). `npm run mocker:socket` preserved.
- Docker data container rebuilt with new config: `config.yaml` mount, port `8088` replaces
  `9000`. Smoke tested end-to-end in the running test environment — all endpoints verified.
- `matches/` added to `.gitignore`.

### 2026-04-13 (session 5) — Phase 2 plugin rewrite (P2.1–P2.5)

- Created `KTPHudObserver.sma` at repo root — complete rewrite of `dod_hud_observer.sma`.
- **Removed:** `#include <fakemeta>`, `<sockets>`, `<dodfun>`. No Metamod dependencies.
- **Added:** `#include <curl>`, `<dodx>`. Transport is HTTP POST via KTPAMXXCurl;
  game events via DODX forwards (`dod_client_spawn`, `dod_client_prone`,
  `dod_client_changeteam`, `client_death`, `dod_control_point_captured`,
  `controlpoints_init`).
- Curl POST helper (`post_event`): persistent `curl_slist` headers built once in
  `task_init_config` (Content-Type + X-Auth-Key + X-Server-Hostname).
  `CURLOPT_COPYPOSTFIELDS` + `CURLOPT_TIMEOUT_MS` 1000ms + async callback cleanup.
  Follows KTPHLTVRecorder pattern exactly.
- `ktp_match_start`/`ktp_match_end` forwards from KTPMatchHandler: sets match context
  (matchId, map, matchType, half). Every `post_event` auto-stamps match metadata.
  Replaces the old `amx_dod_half` admin command.
- Cap zone tracking rewritten: removed `engfunc(EngFunc_FindEntityByString)` entity
  scanning + `pev()` bounding-box polling. Now uses `controlpoints_init` forward +
  `dodx_objectives_get_num` / `dodx_objective_get_data` / `dod_control_point_captured`.
  Simpler and more reliable — no more `task_poll_cap_zones` or bitmask diffing.
- Prone: `dod_client_prone` forward as primary detector + `task_poll_prone` polling
  fallback for deployed-state transitions the forward doesn't catch.
- CVARs simplified: `dod_hud_url` (full ingest URL) + `dod_hud_key` (auth secret).
  Old `dod_hud_host`/`dod_hud_port`/`dod_hud_token` removed.
- Compiled successfully via Docker (`jives/hlds:dod` with `--entrypoint sh`).
  1 harmless warning (`client_disconnect` deprecated). Output: 12,965 bytes.
  **Note:** compiler needs all files copied to `/tmp` — Windows volume mounts cause
  read failures when the compiler runs from a mounted path.
- Updated CLAUDE.md: architecture diagram, compile command, key files list.
- P2.6 (KTPInfrastructure Dockerfile) deferred — requires upstream PR.

### 2026-04-14 (session 6) — Phase 3 complete, server picker, bot investigation

- **Phase 3 (P3.1–P3.3):**
  - `gameEvents` shared event bus decouples Socket.IO from game state handlers. Both
    live socket and replay engine feed the same bus; `SocketStoreComponent` listens to
    `gameEvents` instead of raw socket.
  - URL params: `?match=` joins match room, `?server=` joins server room, `?replay=true`
    enables client-side replay engine. No param = legacy `hud_socket` room.
  - Replay component: fetches `events.jsonl` from backend, sorts by tick, schedules
    via setTimeout at correct relative timing. Play/pause/restart/speed controls.
  - Match picker page at `/watch` (also replaces broken `/matches`).
- **Server picker (new P3.1 extension):**
  - Backend: `GET /api/servers` returns known game servers with online status, event
    counts, last-seen time. Server-based Socket.IO rooms (`join_server` event, `server:`
    prefix). Ingest emits to server room alongside match/all/legacy rooms.
  - Frontend: server + match picker page shows available servers (connect pre-match)
    and stored matches (replay). `/screen?server=<hostname>` connects to a specific
    game server's event stream regardless of match state.
- **Bot support (P0.9):**
  - Metamod-P confirmed incompatible with KTP-ReHLDS (garbled `LoadLibrary` crash).
  - ReAPI `CreateFakeClient` = NULL (not implemented).
  - Fakemeta module not compiled for KTPAMXX (source exists but needs AMBuild toolchain).
  - Resolution: use KTPMatchHandler's built-in `.override_ready_limits` (chat command,
    reduces to 1 player per team). Solo testing with DoD client + mocker for frontend dev.
- **Docker cleanup:** Removed broken Metamod-P + MarineBot mounts from docker-compose.yml.
  Game containers are clean KTP-ReHLDS again. Updated testing instructions to use chat
  commands (`.scrim`, `.override_ready_limits`, `.ready`).

---

## Upstream PRs pending (DO NOT FORGET)

These are local uncommitted patches in sibling repos that need to be contributed upstream
to `afraznein` once the full local build + runtime is validated. Keep them dirty in
`git status` as a reminder — do not commit locally.

### KTPInfrastructure — `build/rehlds/Dockerfile`

**Why:** KTPReHLDS repo restructured after KTPInfrastructure v1.1.0. `build.sh` moved
from `rehlds/build.sh` to repo root, and the top-level `CMakeLists.txt` now lives at
repo root, making the build output one directory shallower. Current Dockerfile fails
at `sed: can't read build.sh: No such file or directory`.

**Patch applied locally 2026-04-11:**

- `WORKDIR /build/KTPReHLDS/rehlds` → `WORKDIR /build/KTPReHLDS`
- Artifact paths: `rehlds/build/rehlds/...` → `build/rehlds/...` (drop one `rehlds/`)

**Status:** committed locally on branch `fix/build-dockerfiles` in `d:/Git/KTPInfrastructure`.
Push + PR after full validation.

### KTPAMXX — missing `support/ambuild/` in Docker build path

**Why:** `support/ambuild/` is `.gitignored` in KTPAMXX. Both the KTPAMXX-own
`docker-build.sh` and `KTPInfrastructure/build/amxx/Dockerfile` assume the dir
already exists (they `cd support/ambuild && pip install .`). Neither repo does
the checkout. afraznein's local workflow populates it via `support/checkout-deps.sh`
then mounts it into the container — so KTPInfrastructure can't build from a
fresh clone without manual setup.

**Workaround applied locally 2026-04-11:**

- Cloned `alliedmodders/ambuild` into `d:/Git/KTPAMXX/support/ambuild/` (gitignored —
  no pollution of the tracked tree).
- No Dockerfile patch needed for local builds.

**Upstream proposal:** Add a `RUN git clone --depth 1 https://github.com/alliedmodders/ambuild support/ambuild`
step to `KTPInfrastructure/build/amxx/Dockerfile` so the build is reproducible from
a fresh clone. Submit as part of the infra PR.

### KTPInfrastructure — `build/curl/Dockerfile`

**Why:** `zlib.net` removes old point releases from its root as new ones ship. The
Dockerfile pinned `zlib-1.3.1.tar.gz` which is now 404 (current is `zlib-1.3.2`).
Build fails with wget exit 8.

**Patch applied locally 2026-04-11:**

- `zlib-1.3.1` → `zlib-1.3.2` (3 occurrences: wget URL, tar target, cd target)

**Status:** committed locally on branch `fix/build-dockerfiles`. Push after full validation.

---

## Open questions (as they come up)

- EPS per competitive 6v6 match — needed to judge if per-event POST holds up or if we need batching.
- KTPHLTVRecorder `.dem` output path on data server (for Phase 5 co-location).
- KTPInfrastructure commit access — user coordinating with `afraznein`.
