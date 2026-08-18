# HLTV↔overlay sync — measurement runbook

**Goal:** make the overlay timer equal **what the HLTV footage shows** (overlay − footage ≈ 0).
Decompose the gap into machine-measurable segments, prove each pipeline component at runtime, and
decide whether the fix is a **dynamic serve-delay correction** (proxy-side) or a **per-session
calibration** (client-side) — and whether it survives the halftime changelevel.

## The bug (why this isn't a transient glitch)

Our sync mechanism delays the overlay by `delaySeconds` = the proxy's **reported `Delay 60`** rcon
field ([hltvSync.ts:65-68] `broadcastNow`), so the overlay sits at **live − 60**. Observed live
(2026-06-26 CHI1): overlay **2:54** vs DoD client **5:05** → overlay **~131s AHEAD** of the footage.

The mechanism assumes **`experiencedDelay == reportedDelay`**. The authoritative ReHLDS proxy source
(`KTPReHLDS/rehlds/HLTV/`) disproves it: `delay` is only the **clamp/floor** for the proxy's single
broadcast clock `m_ClientWorldTime` (`RunClocks` lets it sag up to `delay+10` behind live, [Proxy.cpp:2585-2617]);
buffer = **2×delay** ([Proxy.cpp:2489]); **map change re-anchors it** (`NewGameStarted` resets to
`GetTime() − delay`, [Proxy.cpp:2529-2553]). The experienced delay then adds relay hops + client
playback buffer + post-changelevel fill — none captured by the cvar. So the overlay is aligned to the
**wrong reference**, and the offset likely **shifts at halftime**. The 131s is the proof.

## Overlay side vs footage side — what's machine-readable

- **Overlay — fully measurable from this machine.** `broadcastNow`, `lastEventTick`, the snapshot
  `timeleft` a fresh OBS source anchors to. `segment-probe.cjs` / `prod-overlay-read.cjs`.
- **Footage — was eyes-only; now machine-readable via a relay.** A `delay 0` HLTV relay chained off the
  master re-broadcasts what it receives, so its rcon `Game Time` = the **master's serve point**.
  `proxySrvDelay = masterGameTime − relayGameTime`. The only piece still needing your eyes is the
  **relay-vs-real-client residual** (a relay is `TYPE_PROXY`, the footage is `TYPE_CLIENT`).

## The discriminator (one number answers "is our mechanism correct?")

`relayVsOverlay = relayGameTime − broadcastNow` (both = "live − their delay"):
- **≈ 0** → overlay matches the master serve point; the whole gap is **CLIENT-side** → fix = per-session
  calibration (relay can't see this residual; one human spot-check closes it).
- **≪ 0** → master serves much further back than the overlay → mechanism reference is **wrong** /
  **PROXY-side** → auto-fixable by feeding the *measured* serve delay into the buffer.

## Tooling

| tool | reads | use |
| --- | --- | --- |
| `segment-probe.cjs` | `/api/hltv/status` + Socket.IO snapshot + master rcon + relay rcon | **primary** — one row decomposing every segment; `--csv` for a half |
| `relay-probe.cjs` | master rcon + N relay rcons | serve-delay over time; multi-viewer + join-dependence + across-changelevel |
| `relay-launch.sh` | — | spins a throwaway `delay 0` relay (local docker or data-server) |
| `analyze-segment-csv.cjs` | a segment-probe CSV | stats + slope + STEP + map-change behavior + PASS/FAIL verdict + discriminator |
| `sync-health.sh` | relay units + logger + the CSV's own footage columns | **liveness gate** — timer-run on the data server; failure → Discord via `ktp-systemd-alert@` |
| `prod-overlay-read.cjs` | snapshot + status | quick one-instant overlay read |
| `prod-overlay-shot.cjs` | headless chromium of `:3000/screen` | the literal "what does the HUD render" PNG |
| `sniff-prod-events.ts` | Socket.IO | confirm `time_sync` arrives every 30s (cadence health) |

Formulas live in `lib/sync-math.cjs` (gated by `backend/src/__tests__/syncMath.test.ts`); the shared
GoldSrc rcon client is `lib/rcon.cjs`.

### A live logger is not proof of measurement

On **2026-07-24 23:35 EDT** the three relays were stopped and `sync-relay@.service` removed, while
`sync-logger.service` kept running and exiting 0. systemd saw nothing fail, so no `OnFailure` fired —
the logger simply wrote `relayGameTime`/`proxySrvDelay`/`relayVsOverlay` **blank** with `RELAY_DOWN`
in the flags column for **3.5 days**, silently discarding the entire footage side of the measurement.
`sync-health.sh` (installed + armed by `deploy-sync-monitor.sh`, every 15 min) exists for exactly
this: it gates on the *populated columns*, not on unit liveness. Restored 2026-07-29; relays are now
`enable`d so they also survive a reboot.

## Where the captured CSVs live

**The prod monitor is torn down.** As of 2026-08-17 there is no `sync-monitor`
systemd unit and no `/opt/sync-monitor/` on the data server, so nothing is being
captured and **the 2026-06-28..08-02 soak cannot be regenerated**. That capture is
the evidence behind the RESOLVED section below, so treat it as primary data, not
as scratch.

It is archived outside this repo at:

```
d:/Git/_ktp-archive/hud-sync-soak-2026-06-28_2026-08-02.tar.gz   # 21 MB, 36 files
```

Deliberately outside the working tree: `e2e/repro/soak-logs/` and
`e2e/repro/logs/` are **gitignored**, and ignored files sit inside
`git clean -xdf`'s blast radius — irreplaceable data must not live there. They stay
out of git proper because history is permanent and this repo is cloned directly by
Tony's LAN broadcast tooling.

To capture again, redeploy the monitor with `deploy-sync-monitor.sh` (installs the
systemd unit writing `/opt/sync-monitor/logs/sync-YYYY-MM-DD.csv`), then pull a
window down:

```bash
mkdir -p e2e/repro/soak-logs
rsync -av cadaver@74.91.112.242:/opt/sync-monitor/logs/sync-2026-0*.csv e2e/repro/soak-logs/
```

Feed a capture to `analyze-segment-csv.cjs`, and check usability with
`sync-health.sh` before trusting it — it gates on the *populated columns*, not unit
liveness, and the 2026-06-28 file is the known blind one (relays down, footage
columns empty).

## Per-component runtime-proof matrix

| component | measurement | healthy | drift signature |
| --- | --- | --- | --- |
| plugin→backend latency | `/metrics` `avg_latency_ms` | ~1–2s | growing → POST starvation / clock skew |
| backend buffer delay | `overlayLag = lastTick − broadcastNow` | ≈ `delay` | ≠ delay → buffer math wrong |
| `delaySeconds` stability | master rcon `Delay`, logged all match | constant | changes mid-match (map-change re-read) |
| broadcastNow monotonic | `STEP` detector | no STEP | jump >2s w/o tick reset = failed-sample resume |
| backend↔game-server skew | `clockErrPx` over time | flat ≈ 0 | linear slope = host NTP skew |
| `time_sync` cadence | `sniff-prod-events` | every 30s | gaps = half-1 task wedge; timer coasts on setInterval |
| socket→render | snapshot `timeleft` vs broadcastNow; PNG | match ±1–2s | mismatch = render/store bug |
| browser↔backend skew | overlay timer vs expected `timeleft` | within ~1s | offset = OBS-machine clock skew (uncorrectable today) |
| **proxy serve-delay** | relay `Game Time` vs live | stable | grows w/ time or join = deep-buffer-join |
| client playback buffer | experienced − proxySrvDelay (residual) | small, stable | large/variable = client-side, calibration won't hold |

## Local validation gate (run BEFORE staging live)

Against the KTPInfrastructure docker stack (`cd ../KTPInfrastructure && make local-up`, `delay 60`):

1. **B1 controlled delay** — `segment-probe` one-shot: `overlayLag ≈ 60`, `clockErrPx ≈ 0`.
2. **B2 relay** — `relay-launch.sh --docker-exec <data-container>` off `hltv-1`, then `relay-probe.cjs`:
   does a fresh relay experience `delay` exactly or more? (reproduces / refutes the deep-buffer mechanism
   locally). Gotchas the script handles (GoldSrc hltv): relay port via `-port` not cfg `port`; run from an
   instance dir that **symlinks** the engine `.so`s (don't `cp -a`); and issue `connect` via **rcon after
   startup** with `serverpassword <master proxypassword>` first — the cfg `connect` runs before the Proxy
   module loads and leaves the relay "Not connected".
   *Verified 2026-06-28 on the local stack: a fresh relay experiences `proxySrvDelay ≈ 62s` (≈ the
   configured 60), flat — so a relay does NOT exhibit a large excess locally; the master serves at
   ~live−60 and `relayVsOverlay ≈ −2` (CLIENT-side). The prod ~131s excess is therefore not a master
   serve-point effect reproducible by a relay — it points at a relay-chain hop or true player-client
   buffering, to confirm live.*
3. **B2b relay-vs-real-client** — connect an actual DoD spectator to local `hltv-1` alongside the relay;
   compare relay `Game Time` to the client's rendered clock. Agreement (±1–2s) ⇒ the relay faithfully
   stands in for the footage; divergence ⇒ that's the `TYPE_PROXY`-vs-`TYPE_CLIENT` residual the live
   eyes-reads must carry. **Gate before trusting the relay live.**
4. **B3 decay** — `sh local-decay-test.sh` (≥300s): offsets stay flat (verdict PASS).
5. **B4 stress** — `sh local-stress-test.sh --game-rcon <h:p> --game-pw <pw> --changelevel <map>`:
   `queueDepth` decays smoothly across the changelevel (DRAIN INVARIANT PASS), no STEP, delay re-reads.
6. `npm run test` (covers the formula math).

## Servers (spectator connect = `74.91.112.242:<port>`)

| Server | spec port | RCON (internal) |
| --- | --- | --- |
| KTP - Denver 5 | 27034 | 127.0.0.1:27034 |
| KTP - Atlanta 1 | 27020 | 127.0.0.1:27020 |
| KTP - New York 1 | 27035 | 127.0.0.1:27035 |
| KTP - Chicago 1 | 27040 | 127.0.0.1:27040 |
| KTP - Dallas 1 | 27025 | 127.0.0.1:27025 |

(Master proxy rcon password = `config.hltv_sync.servers.<host>.rcon_password` in the operator-owned,
gitignored `config/online/config.yaml` — pass via `--hltv-pw`, **redact when sharing logs**.)

## Match-day sequence (one decomposed CSV)

1. Pre-flight: `GET /api/hltv/status` shows the match live + `lastEventTick` advancing; the first
   `segment-probe` row confirms the proxy's **actual** `Delay` value (don't assume 60).
2. Launch a relay off the live proxy: `sh relay-launch.sh --connect 74.91.112.242:<spec> --port <relayPort> --pw <pw> --bin <hltv>` (or `--docker-exec` on the data server).
3. Log the whole half:
   `node segment-probe.cjs "<server>" --hltv 127.0.0.1:<port> --hltv-pw <pw> --relay 127.0.0.1:<relayPort> --relay-pw <pw> --interval 5000 --csv half1.csv`
4. In parallel, `sniff-prod-events` to confirm `time_sync` cadence.
5. Connect a fresh DoD spectator; report your join wall-time; hand-read your client clock at ≥3 instants
   (~5min apart) + a fresh-rejoin near half-end → fill the `yourClientTimeleft` CSV column.
6. **Keep the relay connected through the halftime changelevel** — the decisive stability sample.
7. Analyze: `node analyze-segment-csv.cjs half1.csv --delay <actual>`. Decide:
   - **proxy-side** (`relayVsOverlay ≪ 0`) → feed the measured serve-delay into the buffer (continuous
     co-located relay, or correct `delaySeconds`) — not the cvar.
   - **client-side** (`relayVsOverlay ≈ 0`, residual in your client) → one-touch per-session calibration.
   - **survives halftime?** flat across the map change → a per-match constant can hold; shifts → must be
     re-applied per half / driven dynamically. Given `NewGameStarted` re-anchors, expect the latter.

## Calibration write (DO NOT run without explicit go-ahead)

Live, reversible, resets to 0 on backend restart unless baked into `config/online/config.yaml`. Sign:
overlay AHEAD (less timeleft) → delay it MORE → **negative** offset. Auth key = `config.ingest.auth_key`
(redact when displaying).

```sh
curl -X PUT 'http://74.91.112.242:3001/api/hltv/calibration/KTP%20-%20Atlanta%201' \
  -H 'X-Auth-Key: <REDACTED>' -H 'Content-Type: application/json' \
  -d '{"offsetMs": -131000}'      # tune to the measured gap
```

Verify after: re-run `segment-probe.cjs` — `calibMs` reflects it and `broadcastNow` drops by
`|offset|/1000`; the HUD timer should now match your client within a few seconds.

---

## RESOLVED (2026-07-03) — it was never an HLTV delay problem

The 4.5-day monitor soak + a live ATL1 report closed this. The delay pipeline is **healthy**
(`relayVsOverlay` p50 = −2.3s across CHI1/NY1/ATL1; kill/cap events match footage). The "overlay off
by minutes / pinned at 0:00" symptom is the **timer's source value**, not its delivery:

- AMXX `get_timeleft()` counts from **map load** (`amxmodx.cpp:2235`, clamps <0 → 0). Its round-restart
  rebase (`emsg.cpp Client_TextMsg`) only parses **CS** tokens (`#Game_C`/`#Game_w`) — DoD never sends
  them.
- KTPMatchHandler goes live via `mp_clan_restartround 1` after ready-up, and DoD's gamerules rebase the
  real half end to **restart + mp_timelimit** (the client HUD clock tracks this; halves verifiably end
  at its zero).
- → in every match the overlay clock ran AHEAD by the ready-up duration (06-26's "131s" = that half's
  ready-up) and pinned at 0:00 at half end. Pubs unaffected (no clan restart): 912 soak map segments,
  pinned-at-zero median 0s.

**Fix:** `hud_timeleft()` in `KTPHudObserver.sma` — anchors `g_half_end_gt = get_gametime() +
mp_timelimit·60` in the `ktp_match_start` hook (forward fires just after the go-live restart), falls
back to `get_timeleft()` when no match is live. **Do NOT use `calibrationOffsetMs` for this** — it
would have skewed a correctly-delayed overlay.

Validation: local docker + `amx_ktp_test_setup_match/advance_pending/advance_live` (fires
`ktp_match_start` on an aged map) → recorded `half_start.timeleft` must equal full `mp_timelimit·60`,
not `timelimit·60 − map_age`. Then next matchday: overlay 0:00 must coincide with the real half end.

Still real, still open (separate, lower priority): `hltv-restart.timer` (03:00 **and 11:00 ET**)
empties master buffers → reconnecting viewers get near-live footage (no spoiler delay) for one map;
mid-map proxy-type joins land at buffer start (client joins may differ); frontend counts down through
engine pauses until the next post-unpause `time_sync`.
