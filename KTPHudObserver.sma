/**
 * KTPHudObserver.sma
 *
 * Day of Defeat 1.3 HUD Observer Plugin — KTP Stack Edition
 * Authored by Jimmy Lockhart aka cadaver https://github.com/JimmyLockhart65616
 *
 * Sends real-time game events as JSON via HTTP POST (KTPAMXXCurl) to the
 * HUD Observer backend. Replaces the vanilla Metamod version that used
 * fakemeta/sockets/dodfun.
 *
 * Install: compiled .amxx goes into addons/ktpamx/plugins/
 *          add "KTPHudObserver.amxx" to addons/ktpamx/configs/plugins.ini
 * Requires: KTPAMXX (extension mode), dodx_ktp, amxxcurl_ktp
 *
 * CVARs (set in server.cfg or ktpamx/configs/amxx.cfg):
 *   dod_hud_url    "http://127.0.0.1:8088/ingest"  Backend ingest endpoint
 *   dod_hud_key    ""                               X-Auth-Key value
 */

#include <amxmodx>
#include <amxmisc>
#include <dodx>
#include <curl>
#include <ktp_version_reporter>

// dodx_get_round_time ships in dodx.inc from KTPAMXX 2.7.23. Guarded
// self-declaration so this plugin compiles against older includes too
// (e.g. KTPInfrastructure CI pinned to an earlier KTPAMXX): the native is
// bound optionally at load via plugin_natives/set_native_filter either way.
#if !defined dodx_get_round_time
native Float:dodx_get_round_time();
#endif

// dodx_get_wave_time: engine-authoritative seconds to a team's next
// reinforcement wave (CDoDTeamPlay::m_fl{Allies,Axis}WaveTime). Not shipped by
// any dodx yet — declared guarded and bound optionally exactly like
// dodx_get_round_time above, so the plugin runs on the open-loop estimate today
// and flips to the closed loop the moment a module carrying it lands, with no
// second plugin deploy.
#if !defined dodx_get_wave_time
native Float:dodx_get_wave_time(team);
#endif

// dodx_get_score_tick_time: engine-authoritative seconds to the map's next
// TERRITORIAL scoring tick, straight off dod_control_point_master
// (CControlPointMaster::m_fGivePointsTime). Declared guarded and bound
// optionally exactly like the two above, so the plugin runs the observed-phase
// estimator on today's fleet and flips to the closed loop the moment a module
// carrying it lands, with no second plugin deploy.
#if !defined dodx_get_score_tick_time
native Float:dodx_get_score_tick_time();
#endif

// dodx_get_score_tick_period: the map's nominal scoring period
// (CControlPointMaster::m_iGivePointsDelay). Only needed on the closed-loop
// path, where the native answers the countdown directly and the open-loop
// estimator never locks a MEASURED period — without this the wire carries no
// `every` and the frontend has to fall back to a fixed ceiling, which a map
// with a long period would trip. Bound optionally like the rest.
#if !defined dodx_get_score_tick_period
native dodx_get_score_tick_period();
#endif

// ktp_is_match_active: KTPMatchHandler's only native (KTPMatchHandler.sma:3852).
// Returns 1 while a match is LIVE, PENDING (ready-up) or PRE-START — which is
// exactly what makes it useful here: paired with our own g_matchActive (set only
// at go-live) it isolates the ready-up window, the one match phase KTPMatchHandler
// exposes through no forward at all.
//
// KTPMatchHandler ships no include, so consumers hand-declare it (cf.
// KTPPracticeMode.sma:146). Bound OPTIONALLY via the native filter below: pub and
// practice boxes run this plugin without the match handler and must still load.
#if !defined ktp_is_match_active
native ktp_is_match_active();
#endif

// ─── Constants ───────────────────────────────────────────────────────────────

#define PLUGIN  "KTP HUD Observer"
#define VERSION "2.6.0"
#define AUTHOR  "cadaver"

#define MAX_PLAYERS     32
#define MAX_FLAGS       32
#define MAX_CAPTORS     12
#define TIME_SYNC_DELAY 30.0
#define PLAYER_POLL_INTERVAL 0.25
#define ZONE_POLL_INTERVAL  0.5
#define BUFFER_SIZE     4096
// 3s — accommodates production /ingest p95 latency observed during scrim
// (saturation under 5-canary aggregate load; per-event POST p95 ~1.2-1.8s).
// 1s timed out enough to starve repeating tasks (zone polling / time_sync).
#define CURL_TIMEOUT_MS 3000

// Task IDs — used to clear stale tasks on map change before re-scheduling.
// AMXX task persistence across changelevel is inconsistent in practice;
// we reschedule in plugin_cfg and remove_task() defensively to avoid dupes.
#define TASK_ID_INIT_CONFIG  9001
#define TASK_ID_POLL_PLAYER_STATE   9002
#define TASK_ID_POLL_ZONES   9003
#define TASK_ID_TIME_SYNC    9004
#define TASK_ID_EMIT_FLAGS   9005
#define TASK_ID_GOLIVE_REWIPE 9006
#define TASK_ID_RESET_SNAPSHOT 9007
#define TASK_ID_PHASE_POLL   9008

// Go-live restart detection. The engine respawns the ENTIRE roster in one frame
// when the mp_clan_timer countdown ends and frags are zeroed; mid-countdown
// respawn waves are only 2-3 players (prod-measured), so a burst this large is
// unambiguous. Sized for the 6v6 match format — smaller rosters simply fall
// through to the task fallback.
#define GOLIVE_SPAWN_BURST   8
#define GOLIVE_BURST_WINDOW  1.5

// ─── Broadcast phase ─────────────────────────────────────────────────────────
// Every phase EDGE that goes on air is forward-driven (ktp_match_start, the
// go-live re-wipe, ktp_half_end, ktp_match_end), so the poll below only has to
// catch ready-up — which KTPMatchHandler signals through nothing — and re-seed a
// backend that restarted. That split is deliberate: repeating tasks can wedge
// through half 1 on prod, and a wedged poll must not be able to cost us a
// transition the casters are looking at.
#define PHASE_POLL_INTERVAL  2.0
// Forced re-POST even when nothing changed, so a backend that restarted mid-half
// re-seeds its cache (and therefore /hq and every joining overlay) within one
// interval instead of staying blank until the next real transition.
#define PHASE_HEARTBEAT_SEC  30
// How long "FINAL" holds after ktp_match_end. Matches hud.json's
// statsboard_match_displaytime (90s) so the caption and the FINAL STATS board
// leave the screen together.
#define POSTMATCH_HOLD_SEC   90
// Per-CP deferred captor/capout emission (TASK_ID_DEFER_BASE + cp_index, one
// per flag). dodx dispatches dod_score_event ~0.25s AFTER dod_control_point_captured,
// so flag_captured + the capout board are emitted from this short one-shot —
// after the captor batch has filled — instead of synchronously with an empty batch.
#define TASK_ID_DEFER_BASE   9100
#define DEFER_DELAY          0.5

// Team IDs (dodconst.inc: ALLIES=1, AXIS=2)
#define TEAM_UNASSIGNED 0
#define TEAM_ALLIES     1
#define TEAM_AXIS       2

// Prone state labels
#define PRONE_STANDING  0
#define PRONE_PRONE     1
#define PRONE_DEPLOYED  2

// ─── Match Types (mirror KTPMatchHandler) ────────────────────────────────────

enum _:MatchType {
    MATCH_TYPE_COMPETITIVE = 0,
    MATCH_TYPE_SCRIM = 1,
    MATCH_TYPE_12MAN = 2,
    MATCH_TYPE_DRAFT = 3,
    MATCH_TYPE_KTP_OT = 4,
    MATCH_TYPE_DRAFT_OT = 5
};

// ─── Globals ─────────────────────────────────────────────────────────────────

// Curl persistent headers — built once in task_init_config, never freed.
// SList_Empty is the sentinel for "not yet initialized"; see task_init_config
// for the rationale (UAF avoidance across overlapping async POSTs).
new curl_slist:g_curlHeaders = SList_Empty;

// CVAR cache
new g_cvar_url[256];
new g_cvar_key[128];

// Match state (set by ktp_match_start / ktp_match_end forwards)
new bool:g_matchActive = false;
new g_matchId[128];
new g_matchMap[64];
new g_matchType;
new g_matchHalf;
// Gametime when the live half's clock expires, anchored at ktp_match_start
// (KTPMatchHandler fires it right after the go-live mp_clan_restartround).
// 0.0 = no live half → hud_timeleft() falls back to get_timeleft() (pubs).
// FALLBACK ONLY when dodx_get_round_time() is available (see hud_timeleft).
new Float:g_half_end_gt = 0.0;

// dodx_get_round_time() availability (dodx_ktp 2.7.23+). Optional-native
// binding via plugin_natives/set_native_filter: on older modules the plugin
// still loads, this goes false, and hud_timeleft() runs the anchor fallback.
// Never call the native while false — the runtime trap would abort the plugin.
new bool:g_has_round_time_native = true;

// Last accepted native reading + when, for the end-of-half artifact guard in
// hud_timeleft_f(): as a half expires by timelimit the engine's OWN round-cycle
// restart flips the same restart-projection fields the native reads for the
// go-live countdown, so the final time_sync of the half can read ~a full half
// (prod: 7×/week, always ONE bad event with half_end <1s behind it). -1.0 = no
// reading yet. g_native_hold_until > 0.0 = artifact detected, serving the held
// countdown until the hold expires (self-heals if the jump was a real rebase,
// e.g. a sub-35s .restarthalf).
new Float:g_last_native_rem = -1.0;
new Float:g_last_native_gt = 0.0;
new Float:g_native_hold_until = 0.0;

// Go-live window gate, read by the HALF-CLOCK (hud_timeleft_f's in_golive).
// NOTE: prod never emits RoundState==1, so in practice this stays armed for the
// whole deadline window — the clock logic depends on exactly that lifetime.
// Do NOT clear it early; use g_awaiting_stat_rewipe for stat-side gating.
new bool:g_awaiting_round_live = false;
new Float:g_round_live_deadline = 0.0;

// Go-live STAT re-wipe gate — deliberately SEPARATE from g_awaiting_round_live
// above (that one doubles as the clock's go-live window and must keep its full
// lifetime; clearing it at the restart edge would change clock behavior).
//
// The engine zeroes frags at the END of the go-live mp_clan_timer countdown
// (~10s), but ktp_match_start — our first wipe — fires at its START. Every kill
// during that countdown is therefore counted by the HUD and then wiped by the
// engine, leaving the overlay permanently ahead of the in-game scoreboard for
// the rest of the half. RoundState==1 was meant to mark the restart edge, but
// the DoD engine does not emit it on prod (KTPMatchHandler times out on the same
// signal every match), so the re-wipe is driven by the restart's own mass-respawn
// burst, with a task fallback. See do_golive_stat_rewipe().
new bool:g_awaiting_stat_rewipe = false;
new g_golive_spawn_count = 0;
new Float:g_golive_spawn_t0 = 0.0;

// ─── Broadcast phase state ───────────────────────────────────────────────────
// See compute_phase() for the precedence table and the reasoning behind each of
// these. In short, none of the existing match globals can answer "what phase is
// this" on their own: g_matchActive stays TRUE through halftime (ktp_half_end
// clears no match identity), and KTPMatchHandler's _ktp_mode localinfo is
// written 11 lines AFTER the forward that tells us halftime began.
new bool:g_has_match_active_native = true;
// A match went live on THIS level and no half boundary has ended it. Cleared in
// plugin_cfg, which is what makes the phase machine invariant to the open
// question of whether plugin globals survive a changelevel.
new bool:g_phase_live_this_level = false;
// ktp_half_end fired; covers the pre-changelevel halftime window, where
// _ktp_mode is still "".
new bool:g_phase_halftime_latch = false;
// get_systime() (NOT gametime — that resets to ~0 on the post-match changelevel)
// at ktp_match_end. Drives the POSTMATCH_HOLD_SEC "FINAL" hold.
new g_phase_match_ended_at = 0;
// Last phase POSTed + when, for change-detection and the forced heartbeat.
new g_phase_last[16];
new g_phase_last_at = 0;

// ─── Reinforcement wave clock ────────────────────────────────────────────────
// DoD respawn is a per-TEAM reinforcement wave, not a per-player countdown. The
// clock is idle while a team has nobody waiting, arms on the death that takes it
// from 0 waiting to 1, then fires every mp_clan_respawntime seconds returning
// everyone flagged ready — so a player who dies just before a wave is back
// almost immediately and one who dies just after waits a full period. The two
// sides arm independently and their phases are unrelated.
//
// g_wave_anchor[team] = gametime the clock armed, indexed by TEAM_* (0 unused).
// Only meaningful while wave_pending(team) > 0; see hud_wave_time_f().
new Float:g_wave_anchor[3];

// Seconds the real wave lands AFTER anchor + mp_clan_respawntime. Measured on
// the league fleet 2026-08-09 (broadcast overlay vs the players actually
// appearing): the open-loop estimate ran consistently ~2s early, so the panel
// hit 00:00 while the side was still waiting.
//
// Two mechanisms would produce exactly this and cannot be told apart from
// outside the engine: a fixed post-death delay before DoD counts a body as
// waiting on a wave (the death cam — client_death, which arms our anchor, fires
// at the kill), or a true period simply longer than the cvar. Since the estimate
// now runs exactly ONE cycle (see hud_wave_time_f), both are the same
// arithmetic, so there is nothing to choose between. Moot the day
// dodx_get_wave_time() ships — that path returns before any of this.
#define WAVE_SPAWN_DELAY 2.0

// How long the estimate may keep reading 0 past its own deadline before the side
// is dropped. The prediction carries error, so hiding exactly on it would often
// blank the panel a beat before the players appear; holding zero covers that and
// reads as "any moment now". Bounded, because a panel parked on 00:00 reads as a
// wave that never arrives.
#define WAVE_OVERRUN_GRACE 1.5

// dodx_get_wave_time() availability — same optional-native binding as
// g_has_round_time_native. No shipped dodx exports it yet, so on today's fleet
// this goes false at load and hud_wave_time_f() runs the open-loop estimate.
new bool:g_has_wave_native = true;

// Cached cvar pointers for the open-loop wave estimate. Resolved once in
// task_init_config rather than hashed by name on every poll (hud_wave_time_f
// runs twice per 0.25s tick). 0 = unresolved → estimate unavailable.
new g_pcvar_respawntime = 0;
new g_pcvar_clan_match  = 0;

// ─── Territorial scoring tick ────────────────────────────────────────────────
// DoD awards periodic team points for holding control points, from the map's
// dod_control_point_master, on that entity's own clock. The DoD client shows
// this NOWHERE — not the countdown, not the amount — which is the whole reason
// it is worth putting on a broadcast overlay.
//
// Mirrors backend/src/invariants/scoreTick.ts line for line, with the same
// constant names. That module is the executable specification and is pinned
// against a real recorded match (71 ticks, 0 false positives); this side is
// otherwise untestable, so if you change behaviour here change it there too.
//
// Measured on 1777342963-NY1 (dod_thunder2):
//   - period exactly 30.50s (m_iGivePointsDelay 30 + the master's 0.5s think)
//   - ticks land on an exact 0.5s gametime grid; cap awards nearly all do not
//   - the grid is anchored on the go-live restart and RE-PHASES on every round
//     restart, so the phase is never derivable — only observable
//   - a 0/0 tick emits NO TeamScore at all, so silence is normal, not a fault
#define TICK_GRID_QUANTUM   0.50   // CControlPointMaster think granularity
#define TICK_GRID_TOL       0.06   // covers a 16 fps frame
#define TICK_PERIOD_MIN     20.0   // plausible m_iGivePointsDelay band
#define TICK_PERIOD_MAX     45.0
#define TICK_PHASE_TOL      0.25
#define TICK_CAP_PROXIMITY  0.30
#define TICK_CAPOUT_FLOOR   20     // a single-team delta this big is a round-win
                                   // bonus or the half-2 score seeding, never a tick
#define TICK_OVERRUN_GRACE  0.75
#define TICK_MISS_STRIKES   2      // silent slots with a NONZERO projection before unlocking
#define TICK_MAX_BLIND_ROLL 8
#define TICK_W_STREAK_REQ   3
#define TICK_W_MAX          8
#define TICK_RESET_WINDOW   3.0    // after a restart cascade marker, score deltas are noise

// Longest scoring period still worth putting on air. The panel answers "can
// they hold this flag for one more tick?" — a question that only exists when
// ticks are a recurring beat of the round.
//
// Not hypothetical: measured locally 2026-08-11, dod_anzio runs a 30s period
// while dod_flash runs 900s (15 minutes). On flash the territorial award is
// vestigial — the map is decided by captures — and a 13-minute countdown next
// to the score is noise that pushes the caster's eye to something that will not
// happen this round. Above this bound the block is omitted entirely.
#define TICK_MAX_USEFUL_PERIOD 180.0

// dodx_get_score_tick_time() availability — same optional binding as
// g_has_wave_native. Goes false at load on any dodx that predates the native.
new bool:g_has_score_tick_native = true;
new bool:g_has_score_period_native = true;

// Frame accumulation. TeamScore is broadcast once per scoreboard refresh, not
// once per score change (1444 messages for 71 ticks in the recorded match, with
// one frame producing 25), so a frame is opened on the first message at a given
// gametime and closed lazily when a later gametime is seen.
new Float:g_ts_frame_gt;
new g_ts_frame_hi[3];        // running max per team within the open frame
new g_ts_frame_cnt[3];       // non-default-held counts snapshotted at frame OPEN
new bool:g_ts_frame_open;
new bool:g_ts_frame_capdirty;
new g_ts_last[3];            // last frame-closed score, indexed TEAM_*
new bool:g_ts_seeded;

// Phase state.
new Float:g_ts_anchor;       // gametime of the last CONFIRMED tick
new Float:g_ts_cand_gt;      // bootstrap candidate (0 = none)
new g_ts_cand_d[3];
new g_ts_cand_cnt[3];
new Float:g_ts_period;       // MEASURED from the last two adjacent confirmations
new bool:g_ts_locked;
new g_ts_strikes, g_ts_blind_rolls;
// Declared separately on purpose: in Pawn `new Float:a, b;` tags only `a`, so a
// shared declaration would leave the second one untagged and every assignment
// from get_gametime() would be a silent tag mismatch.
new Float:g_ts_last_cap_gt;
new Float:g_ts_last_reset_gt;

// Award model: award[team] = W * count(CPs held whose default owner != team).
// W is LEARNED online and cross-checked across both teams every tick, because
// the obvious source is unusable: dodx's CP_pointvalue reads m_iIndex on Linux
// (the pd_dcp branch is one int short — docs/dodx-cp-index-space-findings.md).
new g_ts_w, g_ts_w_streak;
new bool:g_ts_w_failed;      // latched off for the rest of the map on first violation
new g_pcvar_score_award = 0; // dod_hud_score_award — rcon kill switch for the numbers

// Grid self-check: if a server's frame timing never lands on the 0.5s grid the
// gate would hide the panel forever with no explanation. Detect and fall back.
new bool:g_ts_grid_ok;
new g_ts_grid_seen, g_ts_grid_miss;

// Player state
new g_player_team[MAX_PLAYERS + 1];
new g_player_prone[MAX_PLAYERS + 1];
new g_player_alive[MAX_PLAYERS + 1];

// Local kill counter — authoritative for the HUD. We can't rely on v.frags
// at client_death time because DODX's Damage-hook path fires the forward
// before the engine's CDODPlayer::Killed() has incremented frags. Reset on
// connect, disconnect, and ktp_match_start (half reset).
new g_player_kills[MAX_PLAYERS + 1];

// Local objective-score counter — sum of positive score_delta from
// dod_score_event with cp_index >= 0. Mirrors the in-game scoreboard's
// ObjScore column. Reset alongside g_player_kills.
new g_player_objscore[MAX_PLAYERS + 1];

// Local death counter — authoritative for the HUD. The engine's ScoreShort
// broadcast on death is unreliable in extension mode (KTPAMXX + ReHLDS +
// dproto), which left pure-victim players (no kills) showing deaths=0 on
// late-join snapshots in prod. Track locally alongside g_player_kills so
// emit_player_score is self-sufficient. Reset alongside g_player_kills.
new g_player_deaths[MAX_PLAYERS + 1];

// ─── Stats accumulators (half-scoped, reset on ktp_match_start) ──────────────
// All slot-indexed alongside g_player_kills. Damage matrix feeds assist
// attribution: g_dmg_taken[victim][attacker] = enemy damage dealt to victim
// since the victim's last spawn (row zeroed on spawn and after each death).
// Only enemy damage accumulates (client_damage skips self + team hits), so
// assists can never be earned by teammates.
new g_dmg_taken[MAX_PLAYERS + 1][MAX_PLAYERS + 1];

// Last known health per slot — where client_damage recovers the victim's PRE-hit
// health from. Seeded on spawn and at the roster dump, then updated from
// client_damage's own POST-hit read on EVERY hit.
//
// dodx reports (int)pev->dmg_take verbatim (KTPAMXX modules/dod/dodx/usermsg.cpp)
// and never clamps it to the victim's remaining health, so the killing blow's
// overkill used to be banked in full. Measured on the NY1 production fixture:
// 95,608 reported vs ~61,000 actually applied — 37% inflation, 53.6% of hits
// overkilling, per-player inflation +42% to +77%. `damage` is the StatsBoard's
// default sort key AND its MVP award, so that flipped the MVP on 2 of 4
// team-halves and re-ordered rows on 3 of 4. It was never cosmetic.
//
// 0 = unknown (fresh slot, not yet seeded, or dead); client_damage falls back to
// post + damage, which IS the pre-hit health whenever the engine applied the
// reported number unmodified.
new g_last_health[MAX_PLAYERS + 1];

#define ASSIST_DAMAGE_THRESHOLD 50

new g_player_damage[MAX_PLAYERS + 1];      // enemy damage dealt this half
new g_player_hits[MAX_PLAYERS + 1];        // enemy hits landed this half
new g_player_hs_hits[MAX_PLAYERS + 1];     // hits with hitplace == HIT_HEAD
new g_player_hs_kills[MAX_PLAYERS + 1];    // normal kills via headshot
new g_player_nade_kills[MAX_PLAYERS + 1];  // normal kills with a grenade weapon
new g_player_gun_kills[MAX_PLAYERS + 1];   // all other normal kills (incl. melee/rockets)
new g_player_assists[MAX_PLAYERS + 1];     // 50+ damage to a victim killed by someone else
new g_player_caps[MAX_PLAYERS + 1];        // flag caps participated in (dod_score_event credits)
new g_player_cap_breaks[MAX_PLAYERS + 1];  // cap breaks: killed an enemy capper on the point (defensive)
new g_player_teamkills[MAX_PLAYERS + 1];   // teamkills committed this half (surfaced in kill feed)
new g_player_cur_streak[MAX_PLAYERS + 1];  // current kill streak (resets on death)
new g_player_best_streak[MAX_PLAYERS + 1]; // longest kill streak this half

// player_stats_summary trigger reasons. Indexes g_summaryReasonStr and the
// per-reason dedupe timestamps (capout + ev_round_end can both fire for the
// same round end; the guard collapses them to one summary POST).
enum _:SummaryReason {
    SUMMARY_ROUND_END = 0,
    SUMMARY_HALF_END,
    SUMMARY_MATCH_END,
    SUMMARY_MANUAL
};
new const g_summaryReasonStr[SummaryReason][] = {
    "round_end", "half_end", "match_end", "manual"
};
new Float:g_lastSummaryAt[SummaryReason];
// Idempotency for the ktp_half_end forward marker event (the summary itself is
// already deduped via g_lastSummaryAt). Reset on ktp_match_start.
new Float:g_lastHalfEndFwdAt;

// Flag ownership cache
new g_flag_owner[MAX_FLAGS];
new g_flag_count;

// Flag metadata cache (read once at flags_init)
new g_flag_name_cache[MAX_FLAGS][64];

// Per-flag default owner (the team that owns it at round start) in DLL space,
// from dodx's CP_default_owner. Two uses: the map-load seed below, and telling a
// round-restart reset apart from a real capture (a reset always lands exactly on
// the default).
//
// dodx only learned this in the build that parses `point_default_owner` out of the
// BSP entity lump; older modules return 0 for every CP, which reads as "all
// neutral" — i.e. exactly today's behaviour. So this is safe to run against an
// un-upgraded fleet: nothing here changes until the module can answer.
new g_flag_default_owner[MAX_FLAGS];

// Round-restart cascade window. The engine resets every CP to its default at a
// round restart and dodx replays that as a burst of dod_control_point_captured in
// a single frame. Set to gametime + CP_RESET_WINDOW the moment we see a reset
// marker; while it is open, cap events that land on a flag's default owner are
// treated as part of the cascade rather than as captures.
new Float:g_cp_reset_until;
new bool:g_cp_reset_task_pending;
#define CP_RESET_WINDOW 0.75

// ─── CP index-space remap (dodx array order -> DLL cp_index order) ───────────
// There are TWO control-point index spaces and they are not always the same:
//
//   dodx array  — the order dodx's entity scan found the CPs (BSP lump / spawn
//                 order). `dodx_objective_get_data` and `dodx_area_get_data`
//                 are indexed in THIS space.
//   DLL cp_index — what `dod_control_point_captured` hands us, and what the
//                 game's own HUD uses.
//
// dodx normally reconciles them by reordering its array by the BSP's
// `point_index` key (SetObj cp_index == point_index - 1). On maps whose
// `dod_control_point` entities carry no usable `point_index`, that reorder is
// silently skipped (`[DODX] BSP parse returned 0 CPs — using entity scan
// order`) and the two spaces diverge — so flag NAMES get attached to the wrong
// captures, and our zone-derived events (emitted in dodx space) disagree with
// our cap events (emitted in DLL space).
//
// We keep ALL of our own state and every emitted `flag_id` in **DLL space**,
// and funnel every dodx read through g_cp_dodx_of_dll[]. Identity by default,
// so maps dodx already got right are untouched.
//
// Verified on dod_saints2_b3e from 65 recorded prod matches, three independent
// ways: (1) flag_cap_started on the map's only capture area (dodx idx 0, the
// bridge) completes as flag_captured on DLL idx 2 in 62% of cases vs 2.7% on
// idx 0; (2) DLL idx 2 is the flag whose captures yield a +2 team-score delta,
// i.e. the sole point_team_points=2 CP; (3) first-capture owner per DLL index
// is allies,allies,mixed,axis,axis — matching the real default owners
// [allies, allies, neutral, axis, axis].
new g_cp_dodx_of_dll[MAX_FLAGS];

// Current cap state per flag (mirror of game-authoritative CAreaCapture fields)
// capping_team: 0=none, 1=allies, 2=axis
new g_flag_capping_team[MAX_FLAGS];
new bool:g_flag_contested[MAX_FLAGS];
new g_flag_last_progress[MAX_FLAGS];     // last-emitted progress %, to avoid spam
new g_flag_prev_allies_count[MAX_FLAGS];
new g_flag_prev_axis_count[MAX_FLAGS];

// Pending captor batch — captor slots collected by dod_score_event, read by
// build_pending_captor_list / build_captor_names for the flag_captured JSON and
// the capout title. NOTE: dodx defers dod_score_event ~0.25s past the cap (see
// the dod_score_event handler below), so this batch is still EMPTY when
// dod_control_point_captured reads it — captor_ids/capout names are therefore
// currently empty (pre-existing latent bug; needs deferred attribution to fix).
new g_flag_pending_captor_ids[MAX_FLAGS][MAX_CAPTORS];
new g_flag_pending_captor_score[MAX_FLAGS][MAX_CAPTORS];
new g_flag_pending_captor_count[MAX_FLAGS];

// Team (TEAM_ALLIES/TEAM_AXIS) of the most recent REAL cap per flag. Set on the
// genuine-cap path in dod_control_point_captured and NOT cleared by the
// neutral/same-owner guards or the post-capout round-restart. dod_score_event
// credits obj_score/caps against THIS (stable) value instead of g_flag_owner —
// the round-restart flips g_flag_owner to neutral inside dod_score_event's
// ~0.25s deferral window, so filtering on the live owner would drop the credit
// for the round-winning cap.
new g_flag_last_capped_by[MAX_FLAGS];

// Deferred flag_captured / capout emission state. dod_control_point_captured
// records the cap here and arms a per-CP one-shot (TASK_ID_DEFER_BASE+cp);
// deferred_emit_cap fires ~DEFER_DELAY later — after dod_score_event has filled
// the captor batch — and emits flag_captured (with captor_ids) + the capout
// board (with capout_by). g_flag_emit_capout is the capout verdict computed
// synchronously at cap time (g_flag_owner is current then).
new g_flag_emit_pending[MAX_FLAGS];      // 1 while a deferred emission is armed
new g_flag_emit_owner[MAX_FLAGS];        // captured new_owner (team)
new g_flag_emit_name[MAX_FLAGS][64];     // captured flag display name
new bool:g_flag_emit_capout[MAX_FLAGS];  // did this cap complete a capout
new Float:g_flag_emit_armed_at[MAX_FLAGS];  // gametime the emission was armed, so
                                            // deferred_emit_cap can tell whether a
                                            // reset was detected after the fact

// Pending cap-break candidates per flag. client_death queues the killer when
// the victim's team was actively capping; task_poll_zones then credits queued
// killers as the capping team's in-zone count drops below a rolling baseline.
// PROD-MEASURED (2026-07-06 forensics, e2e/repro/cap-break-replay.cjs over
// saints2/anjou matchday streams): the engine applies the death decrement to
// m_nNumAllies/m_nNumAxis 0.2–2.5s (p50 ~1.1s) AFTER the killing blow, so the
// original one-shot next-poll confirm caught <20% of real breaks (10 credits in
// 39 matches); and back-to-back kills on one flag overwrote the single
// candidate, losing both. Hence: a small FIFO queue, a multi-poll confirm
// window, and a baseline anchored to min(fresh read, previous poll's count) —
// a fresh read alone can already include an EARLIER victim's decrement, while
// the poll cache alone misses sub-poll voluntary walk-offs. No zone identity
// exists in extension mode, so this counts-drop correlation is the attribution.
// dod_control_point_captured clears the queue (a completed cap is not a break),
// including its round-restart guard paths (a restart zeroes zone counts, which
// would fake a drop).
#define BREAK_QUEUE_MAX     6   // concurrent pending killers per flag (a nade
                                // wipe can drop a full 6v6 side in one window)
#define BREAK_WINDOW_POLLS  5   // confirm window in polls (~2.5s @ ZONE_POLL_INTERVAL)
new g_break_q_killer[MAX_FLAGS][BREAK_QUEUE_MAX];  // FIFO of killer slots
new g_break_q_ttl[MAX_FLAGS][BREAK_QUEUE_MAX];     // polls left before expiry
new g_break_q_count[MAX_FLAGS];                    // queued candidates
new g_break_team[MAX_FLAGS];                       // capping team being broken
new g_break_baseline[MAX_FLAGS];                   // rolling in-zone count baseline

#if defined HUD_REPRO_TEST
// Local-repro scaffolding (gated; compiles to nothing in production builds).
// The headless docker stack has no connected clients (no bots, no fakemeta),
// so dod_score_event can never fill the real captor batch there. These arrays
// let amx_hud_test_cap seed a synthetic captor — standing in for the captor
// dod_score_event would credit — so the deferred flag_captured / capout board
// can be observed carrying populated captor_ids / capout_by on the real
// engine+plugin+backend pipeline. build_pending_captor_list / build_captor_names
// append from these after the real batch.
new g_flag_test_sid[MAX_FLAGS][MAX_CAPTORS][32];
new g_flag_test_name[MAX_FLAGS][MAX_CAPTORS][32];
new g_flag_test_count[MAX_FLAGS];
#endif

// Server hostname (sent as X-Server-Hostname header)
new g_hostname[64];

// ─── Plugin Lifecycle ────────────────────────────────────────────────────────

public plugin_init() {
    register_plugin(PLUGIN, VERSION, AUTHOR);
    KTP_RegisterVersion(PLUGIN, VERSION);

    register_cvar("dod_hud_url", "http://127.0.0.1:8088/ingest", FCVAR_SERVER);
    register_cvar("dod_hud_key", "",                              FCVAR_PROTECTED);
    // On-air kill switch for the PROJECTED SCORING POINTS only — the tick
    // countdown is an observation and is unaffected. The award model is fitted
    // to one recorded map; this lets an operator pull the numbers mid-broadcast
    // by rcon if they ever look wrong, without a redeploy.
    register_cvar("dod_hud_score_award", "1", FCVAR_SERVER);

    // Round events (log events)
    register_logevent("ev_round_start", 2, "1=World triggered", "2=Round_Start");
    register_logevent("ev_round_end",   2, "1=World triggered", "2=Round_End");

    // Game events
    register_event("TeamScore",  "ev_team_score",   "a");
    // No ScoreShort hook: client_death emits player_score for both killer and
    // victim explicitly, using locally tracked g_player_kills/g_player_deaths.
    // The engine's ScoreShort broadcast was unreliable in extension mode.

    // RoundState (DoD: BYTE state, 1=round live, other=freeze). Drives the
    // go-live stat re-wipe so pre-live kills don't drift the HUD above the real
    // scoreboard. Mirrors KTPMatchHandler's own round-live gate
    // (KTPMatchHandler.sma:3903); get_user_msgid resolves the id in extension
    // mode just as it does for TeamScore above.
    new msgRoundState = get_user_msgid("RoundState");
    if (msgRoundState > 0) {
        register_message(msgRoundState, "msg_round_state");
    }

    // Chat
    register_clcmd("say",      "ev_say");
    register_clcmd("say_team", "ev_say_team");

    // Admin command: caster observe
    register_concmd("amx_dod_observe", "cmd_observe", ADMIN_RCON, "<steamid> — caster observe");

    // Diagnostic: dump raw CAreaCapture values for every CP (server console only)
    register_concmd("amx_hud_dump_zones", "cmd_dump_zones", ADMIN_RCON, "dump raw zone state");

    // Caster fallback: force a stats-board popup on the overlay (e.g. if the
    // half-end POST was lost to the changelevel race).
    register_concmd("amx_hud_statsboard", "cmd_statsboard", ADMIN_RCON, "force stats board popup on the HUD overlay");

#if defined HUD_REPRO_TEST
    // Local repro driver (gated): fire dod_control_point_captured via the dodx
    // test-dispatch native, then seed a synthetic captor (simulating the captor
    // dod_score_event credits ~0.25s later). Reproduces the empty-captor_ids bug
    // and confirms the deferred-emission fix on the clientless docker stack.
    //   amx_hud_test_cap <cp> <new_owner> <old_owner> [steamid] [name]
    register_concmd("amx_hud_test_cap", "cmd_test_cap", ADMIN_RCON, "<cp> <new> <old> [sid] [name] — repro cap timing");
#endif

    // Periodic tasks are scheduled in plugin_cfg (see below) so they get
    // re-armed on every map change — repeating tasks set here in plugin_init
    // did not survive changelevel on Denver 5.
}

public task_emit_flags() {
    do_flags_init();
}

public plugin_cfg() {
    // Reset flag state
    for (new i = 0; i < MAX_FLAGS; i++) {
        g_flag_owner[i]          = -1;
        g_flag_default_owner[i]  = 0;
        g_flag_last_capped_by[i] = 0;
        // Cancel any in-flight deferred cap emission from the previous map.
        g_flag_emit_pending[i]   = 0;
        g_flag_emit_armed_at[i]  = 0.0;
        remove_task(TASK_ID_DEFER_BASE + i);
        break_queue_clear(i);
#if defined HUD_REPRO_TEST
        g_flag_test_count[i]     = 0;
#endif
    }
    g_flag_count = 0;
    // gametime restarts at 0 on a new map, so a window left open by the previous
    // map would otherwise read as open for its first CP_RESET_WINDOW seconds.
    g_cp_reset_until = 0.0;
    g_cp_reset_task_pending = false;

    // New map: new grid phase, and a new answer to what a control point is worth.
    score_tick_reset(false);

    // Phase reconcile for the new level. THIS IS THE KEYSTONE of the phase
    // machine: whether plugin globals survive a changelevel is genuinely
    // unresolved (see the note at ktp_half_end), and clearing both latches here
    // makes the answer irrelevant. If globals survived, this forces the correct
    // false; if they didn't, they are already false. Either way the phase after a
    // halftime changelevel comes from _ktp_mode, which is engine-side and does
    // survive.
    //
    // g_phase_match_ended_at is deliberately NOT cleared: the post-match hold is
    // measured in systime and is meant to outlive exactly this changelevel. The
    // backend mirrors the same hold for the case where these globals did reset.
    g_phase_live_this_level = false;
    g_phase_halftime_latch  = false;
    g_phase_last[0] = '^0';
    g_phase_last_at = 0;

    // Clear any stragglers from the previous map, then re-arm.
    remove_task(TASK_ID_INIT_CONFIG);
    remove_task(TASK_ID_POLL_PLAYER_STATE);
    remove_task(TASK_ID_POLL_ZONES);
    remove_task(TASK_ID_TIME_SYNC);
    remove_task(TASK_ID_EMIT_FLAGS);
    remove_task(TASK_ID_RESET_SNAPSHOT);
    remove_task(TASK_ID_PHASE_POLL);

    // Defer CVAR + header init to ensure amxx.cfg has loaded
    set_task(1.0, "task_init_config", TASK_ID_INIT_CONFIG);

    set_task(PLAYER_POLL_INTERVAL, "task_poll_player_state", TASK_ID_POLL_PLAYER_STATE, _, _, "b");
    set_task(ZONE_POLL_INTERVAL,  "task_poll_zones", TASK_ID_POLL_ZONES, _, _, "b");
    set_task(TIME_SYNC_DELAY,     "task_time_sync",  TASK_ID_TIME_SYNC,  _, _, "b");
    set_task(30.0,                "task_emit_flags", TASK_ID_EMIT_FLAGS, _, _, "b");
    // Catches ready-up (which no forward signals) and re-seeds a restarted
    // backend. Every on-air phase EDGE is forward-driven, so a wedged task here
    // can only ever cost the pregame caption.
    set_task(PHASE_POLL_INTERVAL, "task_phase_poll", TASK_ID_PHASE_POLL, _, _, "b");
}

public task_init_config() {
    // Read CVARs
    get_cvar_string("dod_hud_url", g_cvar_url, charsmax(g_cvar_url));
    get_cvar_string("dod_hud_key", g_cvar_key, charsmax(g_cvar_key));
    get_cvar_string("hostname",    g_hostname,  charsmax(g_hostname));

    // Wave-clock cvars, resolved to pointers once (hud_wave_time_f reads them
    // twice per 0.25s poll). These are engine cvars, always present.
    g_pcvar_respawntime = get_cvar_pointer("mp_clan_respawntime");
    g_pcvar_clan_match  = get_cvar_pointer("mp_clan_match");
    g_pcvar_score_award = get_cvar_pointer("dod_hud_score_award");

    // gametime restarts at 0 on a new map — drop anchors from the previous one.
    // Belt and braces: hud_wave_time_f already rejects a negative elapsed, and
    // client_death re-anchors on the first death either way.
    g_wave_anchor[TEAM_ALLIES] = 0.0;
    g_wave_anchor[TEAM_AXIS]   = 0.0;

    // Same reason, plus the learned award weight and the grid verdict are
    // properties of the map we just left.
    score_tick_reset(false);

    // Census of CP default owners. The award model is built entirely on these,
    // and a dodx predating the BSP point_default_owner parse reports 0 for every
    // CP — which silently turns "points held beyond your own" into "all points
    // held" and makes the projection wrong rather than absent. The online W
    // check catches it within three ticks, but an operator wants to see it
    // BEFORE a match, not diagnose it afterwards.
    if (g_flag_count > 0) {
        new owned = 0;
        for (new f = 0; f < g_flag_count && f < MAX_FLAGS; f++) {
            if (g_flag_default_owner[f] != 0) owned++;
        }
        if (owned == 0) {
            server_print("[HUD] score-tick: %d CPs, NONE with a default owner — dodx is likely \
pre-2.7.26 (no BSP point_default_owner parse); projected points will stay hidden", g_flag_count);
        }
    }

    // Build persistent curl headers — ONCE per process, NEVER freed across
    // overlapping async requests. Same UAF class fixed in KTPHLTVRecorder
    // v1.5.1: curl_easy_setopt(CURLOPT_HTTPHEADER) stores the slist pointer
    // by reference; if a request is in-flight when curl_slist_free_all runs,
    // libcurl's poller deref's the freed slist on the next frame tick and
    // crashes inside Curl_strncasecompare during header walk.
    //
    // task_init_config re-fires every map change (re-armed in plugin_cfg),
    // so a server with active map rotation guarantees overlap with whatever
    // POSTs were emitted just before the changelevel. Build once, reuse.
    //
    // Trade-off: dod_hud_url / dod_hud_key / hostname cvar changes between
    // maps won't take effect until next server restart. Acceptable given
    // these are rcon/static-config values, not gameplay-tunable.
    if (g_curlHeaders == SList_Empty) {
        g_curlHeaders = curl_slist_append(SList_Empty, "Content-Type: application/json");

        if (g_cvar_key[0]) {
            new authHeader[192];
            formatex(authHeader, charsmax(authHeader), "X-Auth-Key: %s", g_cvar_key);
            g_curlHeaders = curl_slist_append(g_curlHeaders, authHeader);
        }

        if (g_hostname[0]) {
            new hostHeader[128];
            formatex(hostHeader, charsmax(hostHeader), "X-Server-Hostname: %s", g_hostname);
            g_curlHeaders = curl_slist_append(g_curlHeaders, hostHeader);
        }
    }

    server_print("[HUD] Initialized — URL: %s  Auth: %s  Hostname: %s",
        g_cvar_url,
        g_cvar_key[0] ? "(set)" : "(none)",
        g_hostname);

    // Surface a loud warning if gamerules access isn't wired up. If this returns
    // 0, dodx_get_team_score silently falls back to DODX's message-tracked
    // globals — which sit at 0 in extension mode — and the HUD shows zeros for
    // team score. This canary tells us we'd never know without a redeploy.
    if (!dodx_has_gamerules()) {
        server_print("[HUD] WARNING: dodx_has_gamerules()=0 — team_score will be 0 (gamerules signature lookup failed in DODX)");
    }

    // Send flags snapshot now that URL is set (controlpoints_init fires before CVARs load)
    do_flags_init("map_load");

    // First phase of the level, now that the URL and headers exist (post_event
    // no-ops without them, and the poll's change-gate would then suppress the
    // real first emit for a full heartbeat).
    phase_tick();
}




// ─── HTTP POST Helper ────────────────────────────────────────────────────────

stock post_event(const json[]) {
    if (!g_cvar_url[0]) return;

    // Inject tick, match metadata, and plugin timestamp into event JSON.
    // json always starts with '{', so json[1] skips it; we prepend our own '{'.
    static payload[BUFFER_SIZE];

    new ts = get_systime();

    if (g_matchActive) {
        formatex(payload, charsmax(payload),
            "{^"tick^":%.2f,^"match_id^":^"%s^",^"map^":^"%s^",^"match_type^":%d,^"half^":%d,^"plugin_sent_at^":%d000,%s",
            get_gametime(), g_matchId, g_matchMap, g_matchType, g_matchHalf, ts, json[1]);
    } else {
        formatex(payload, charsmax(payload),
            "{^"tick^":%.2f,^"plugin_sent_at^":%d000,%s",
            get_gametime(), ts, json[1]);
    }

    new CURL:curl = curl_easy_init();
    if (!curl) {
        server_print("[HUD] curl_easy_init() failed");
        return;
    }

    curl_easy_setopt(curl, CURLOPT_URL, g_cvar_url);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, g_curlHeaders);
    curl_easy_setopt(curl, CURLOPT_COPYPOSTFIELDS, payload);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, CURL_TIMEOUT_MS);

    curl_easy_perform(curl, "on_post_complete");
}

public on_post_complete(CURL:curl, CURLcode:code) {
    if (code != CURLE_OK) {
        new error[128];
        curl_easy_strerror(code, error, charsmax(error));
        server_print("[HUD] POST failed (code %d): %s", code, error);
    }
    curl_easy_cleanup(curl);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

stock get_team_str(team, out[], len) {
    if (team == TEAM_ALLIES)     copy(out, len, "allies");
    else if (team == TEAM_AXIS)  copy(out, len, "axis");
    else                         copy(out, len, "spectator");
}

stock get_prone_str(prone, out[], len) {
    if (prone == PRONE_PRONE)         copy(out, len, "prone");
    else if (prone == PRONE_DEPLOYED) copy(out, len, "deployed");
    else                              copy(out, len, "standing");
}

// Escape double-quotes and backslashes for JSON string safety
stock escape_json(const src[], out[], len) {
    new i = 0, j = 0;
    while (src[i] && j < len - 2) {
        if (src[i] == '^"' || src[i] == '\') {
            out[j++] = '\';
        }
        out[j++] = src[i++];
    }
    out[j] = '^0';
}

stock get_steamid(id, out[], len) {
    if (is_user_bot(id)) {
        formatex(out, len, "BOT_%d", id);
    } else {
        get_user_authid(id, out, len);
    }
}

// Grenade-class weapons per dodx weaponData (Utils.cpp): 13/14 live nades,
// 15/16 the _ex variants (rare — get_weaponid remaps live ones), 36 mills bomb.
// Rockets and melee intentionally count as "gun"; the kill event's weapon
// string preserves enough data to reclassify later if casters want it.
stock bool:is_nade_wpn(wpnindex) {
    switch (wpnindex) {
        case DODW_HANDGRENADE, DODW_STICKGRENADE,
             DODW_STICKGRENADE_EX, DODW_HANDGRENADE_EX,
             DODW_MILLS_BOMB: return true;
    }
    return false;
}

// Wipe one slot's stat accumulators plus its damage-matrix row AND column —
// called on connect/disconnect so a reused slot can't inherit a ghost's
// damage history (assists would mis-attribute otherwise).
stock reset_player_stats_slot(id) {
    g_player_damage[id]      = 0;
    g_player_hits[id]        = 0;
    g_player_hs_hits[id]     = 0;
    g_player_hs_kills[id]    = 0;
    g_player_nade_kills[id]  = 0;
    g_player_gun_kills[id]   = 0;
    g_player_assists[id]     = 0;
    g_player_caps[id]        = 0;
    g_player_cap_breaks[id]  = 0;
    g_player_teamkills[id]   = 0;
    g_player_cur_streak[id]  = 0;
    g_player_best_streak[id] = 0;
    // Unknown until the next spawn / roster dump re-seeds it — client_damage
    // runs on its post + damage fallback while this reads 0.
    g_last_health[id]        = 0;
    for (new j = 0; j <= MAX_PLAYERS; j++) {
        g_dmg_taken[id][j] = 0;
        g_dmg_taken[j][id] = 0;
    }
}

// Zero every per-player stat accumulator (half-scoped). Called at go-live from
// ktp_match_start and re-run once at the engine's restart edge
// (do_golive_stat_rewipe) so kills landing in the go-live countdown — which the
// engine wipes on the mp_clan_restartround — don't survive in the HUD and drift
// K/D above the real scoreboard.
stock wipe_all_stat_accumulators() {
    for (new i = 1; i <= MAX_PLAYERS; i++) {
        g_player_kills[i]    = 0;
        g_player_deaths[i]   = 0;
        g_player_objscore[i] = 0;
        reset_player_stats_slot(i);
    }
}

// Re-wipe the half's accumulators at the ENGINE's go-live restart edge, snapping
// the HUD's K/D baseline to the instant the engine zeroes frags.
//
// ktp_match_start wipes at the START of the ~mp_clan_timer go-live countdown;
// the engine zeroes frags at its END. Kills in between are counted by the HUD but
// wiped by the engine, so without this the overlay sits permanently above the
// in-game scoreboard for the whole half (prod-measured 2026-07-19 on
// 1784509712-ATL1: 4 countdown kills produced 6 player-visible K/D deltas).
//
// Idempotent and single-shot per half — whichever source observes the edge first
// (spawn burst, task fallback, or a RoundState==1 on configs that emit it)
// disarms the others. src is logged so matchday forensics can tell which fired.
stock do_golive_stat_rewipe(const src[]) {
    if (!g_awaiting_stat_rewipe) return;
    g_awaiting_stat_rewipe = false;
    remove_task(TASK_ID_GOLIVE_REWIPE);
    g_golive_spawn_count = 0;
    g_golive_spawn_t0    = 0.0;

    wipe_all_stat_accumulators();
    server_print("[HUD] golive stat re-wipe (src=%s gt=%.2f)", src, get_gametime());

    // Re-push zeroed scores so the overlay snaps to 0 at the go-live instant
    // instead of showing the leaked countdown counts until each player's next
    // kill. Uses the tracked team (same reason as emit_stats_summary).
    new maxp = get_maxplayers();
    for (new id = 1; id <= maxp; id++) {
        if (!is_user_connected(id)) continue;
        if (is_user_hltv(id)) continue;
        new team = g_player_team[id];
        if (team != TEAM_ALLIES && team != TEAM_AXIS) continue;
        emit_player_score(id);
    }

    // "GOING LIVE" → "1ST HALF". This is the real go-live edge — the engine's own
    // mass-respawn burst (or the fallback task) — and it is the only prod-reliable
    // one there is: RoundState==1 never arrives, which is why the HQ board's
    // round-phase discriminator was dead for every match ever played.
    phase_tick();
}

// Fallback: fires only if the mass-respawn burst never materialised (roster
// smaller than GOLIVE_SPAWN_BURST, or spawns missed). Scheduled at
// mp_clan_timer + 2s, so it lands just after the engine's restart. A one-shot
// set_task armed here is reliable even in half 1 — KTPMatchHandler's own 5s
// round-live timeout one-shot fires every match on the same servers.
public task_golive_rewipe() {
    do_golive_stat_rewipe("task_fallback");
}

// Get log name for the weapon in the given DODWT_* slot
stock get_wpn_name_for_slot(id, slot, out[], len) {
    new wpn_id = dod_weapon_type(id, slot);
    if (wpn_id <= 0) {
        copy(out, len, "none");
        return;
    }
    xmod_get_wpnlogname(wpn_id, out, len);
}

stock do_prone_change(id, prone_state) {
    new steamid[32], prone_str[16];
    get_steamid(id, steamid, charsmax(steamid));
    get_prone_str(prone_state, prone_str, charsmax(prone_str));

    new ts = get_systime();

    new json[256];
    formatex(json, charsmax(json),
        "{^"event^":^"prone_change^",^"user_id^":^"%s^",^"state^":^"%s^",^"timestamp^":%d000}",
        steamid, prone_str, ts);
    post_event(json);
}

// Half countdown for HUD timer events (half_start / round_start / time_sync /
// round_end classification), in preference order:
//
// 1. dodx_get_round_time() (dodx_ktp 2.7.23+) — CLOSED LOOP: reads DoD's own
//    half-clock accounting (CDoDTeamPlay::m_flDoDMapTime, which the go-live
//    mp_clan_restartround rebases and the client HUD counts from; the restart
//    countdown window is projected from m_flRestartRoundTime). Tracks every
//    engine rebase — go-live, .restarthalf, OT — with no signal dependency,
//    and equals get_timeleft() on pubs. Returns -1.0 when it can't answer
//    (old module via native filter, no gamerules, mp_timelimit 0, implausible
//    read) → fall through.
// 2. g_half_end_gt anchor — OPEN LOOP estimate set at ktp_match_start
//    (+ mp_clan_timer baked offset). Kept for old-module fleets and as the
//    native's fail-soft net. DoD rebases the real half end at the go-live
//    mp_clan_restartround, but AMXX get_timeleft() counts from MAP LOAD — its
//    restart-rebase (emsg.cpp Client_TextMsg) only parses CS tokens (#Game_C /
//    #Game_w), which DoD never sends — so an unanchored match clock would run
//    AHEAD by the entire ready-up duration and pin at 0:00 for minutes.
// 3. get_timeleft() — pubs (no clan restart → map-load clock is correct).
stock Float:hud_timeleft_f() {
    new Float:gt = get_gametime();

    // Gametime restarts near 0 on changelevel — clear the jump-detector state
    // so a stale pre-changelevel reading can't misclassify the new map's clock.
    if (gt < g_last_native_gt) {
        g_last_native_rem = -1.0;
        g_last_native_gt = 0.0;
        g_native_hold_until = 0.0;
    }

    // The effective go-live window: g_awaiting_round_live alone is NOT enough —
    // prod never emits RoundState==1, so the flag stays armed all half; only
    // the deadline bounds the real countdown window.
    new bool:in_golive = g_awaiting_round_live && gt <= g_round_live_deadline;

    if (g_has_round_time_native) {
        new Float:rem = dodx_get_round_time();
        if (rem >= 0.0) {
            // End-of-half artifact: outside the go-live window, a jump from a
            // near-zero reading to ~a full half is the engine's own timelimit
            // round-cycle restart leaking through the native's go-live
            // projection — never a value the client clock shows. Hold the old
            // countdown; half_end + changelevel land within ~1s. The hold
            // expires after 6s so a genuine sub-35s rebase (.restarthalf at
            // the death of a half) recovers on its own.
            // An active hold is sticky for its full window: the arming pattern
            // must not be re-evaluated mid-hold, because the frozen baseline
            // ages past the 35s bound and a late call would fall through and
            // accept the still-corrupted reading. On expiry the native is
            // accepted unconditionally (self-heal for a persistent legit jump,
            // e.g. a sub-35s .restarthalf) — never immediately re-armed.
            new bool:hold_expired = false;
            if (g_native_hold_until > 0.0) {
                if (gt < g_native_hold_until) {
                    new Float:held = g_last_native_rem - (gt - g_last_native_gt);
                    return (held < 0.0) ? 0.0 : held;   // keep pre-jump state
                }
                g_native_hold_until = 0.0;
                hold_expired = true;
            }
            if (!hold_expired && !in_golive
                && g_last_native_rem >= 0.0 && g_last_native_rem < 35.0
                && gt - g_last_native_gt < 35.0
                && rem > g_last_native_rem + 35.0) {
                g_native_hold_until = gt + 6.0;
                new Float:held = g_last_native_rem - (gt - g_last_native_gt);
                return (held < 0.0) ? 0.0 : held;   // keep pre-jump state
            }

            // Go-live request jitter: KTPMatchHandler occasionally issues the
            // mp_clan_restartround AFTER ktp_match_start (prod 1.3-6255-NY1 h2:
            // native read the un-rebased pub clock, half_start emitted 1014
            // instead of ~1209). Until the native sees the restart request, the
            // freshly-baked anchor is the better estimate; the native takes
            // over the moment it catches up.
            if (in_golive && g_half_end_gt > 0.0) {
                new Float:anchor_rem = g_half_end_gt - gt;
                if (rem < anchor_rem - 5.0) {
                    g_last_native_rem = rem;
                    g_last_native_gt = gt;
                    return (anchor_rem < 0.0) ? 0.0 : anchor_rem;
                }
            }

            g_last_native_rem = rem;
            g_last_native_gt = gt;

            // Keep the open-loop anchor honest while both sources live, so a
            // mid-half native outage degrades to a calibrated fallback, and
            // surface residual drift for field forensics (rate-limited).
            if (g_half_end_gt > 0.0) {
                new Float:drift = (gt + rem) - g_half_end_gt;
                if (floatabs(drift) > 2.0) {
                    static Float:last_drift_print;
                    if (gt - last_drift_print > 30.0) {
                        last_drift_print = gt;
                        server_print("[HUD] clock drift: native vs anchor %.2fs (native wins)", drift);
                    }
                }
                g_half_end_gt = gt + rem;
            }
            return rem;
        }
    }
    if (g_half_end_gt > 0.0) {
        new Float:tl = g_half_end_gt - gt;
        return (tl < 0.0) ? 0.0 : tl;
    }
    return float(get_timeleft());
}

stock hud_timeleft() {
    return floatround(hud_timeleft_f(), floatround_floor);
}

// ─── Reinforcement wave clock ────────────────────────────────────────────────

// Players on `team` waiting on the next reinforcement wave. Doubles as the
// "is the clock running" test: DoD's wave clock is idle while this is 0.
//
// Spectators, HLTV and unassigned slots are excluded — they never come back with
// a wave. This can over-count by a player who is not yet ready to spawn (still
// on the death cam, or sitting in the class menu): DoD makes them MISS the wave
// (CBasePlayer::m_imissedwave) and wait for the next one. There is no
// extension-mode read for m_irdytospawn, and over-counting is the benign
// direction — the pill promises a team N bodies, not a named player.
stock wave_pending(team) {
    new n = 0;
    for (new id = 1; id <= get_maxplayers(); id++) {
        if (!is_user_connected(id)) continue;
        if (is_user_hltv(id))       continue;
        if (g_player_team[id] != team) continue;
        if (g_player_alive[id])     continue;
        n++;
    }
    return n;
}

// Seconds until `team`'s next reinforcement wave; -1.0 when there is no honest
// answer, which the caller surfaces by omitting the side entirely (the overlay
// hides the pill rather than showing a fabricated countdown).
//
// `pending` is passed in rather than recomputed: the caller needs the same count
// for the emitted `pending` field, and this runs on the 4 Hz poll path (which
// already has a perf-warning history). Reading it once also makes the "+N can
// never disagree with the timer beside it" guarantee structural instead of
// incidental — both come from the same read of the same instant.
//
// Source preference, mirroring hud_timeleft_f():
// 1. Idle clock (nobody waiting) — -1.0 before consulting either source, since
//    neither is meaningful and the engine field is likely a stale past value.
// 2. dodx_get_wave_time() — CLOSED LOOP, the engine's own wave accounting.
//    Correct on pubs and across every restart. Not shipped by any dodx yet.
// 3. Open loop: mp_clan_respawntime (+ WAVE_SPAWN_DELAY) against the anchor
//    armed in client_death. Gated on mp_clan_match — on a pub the wave period
//    comes from the map, not this cvar, so the estimate would be confidently
//    wrong. A gametime regression (changelevel) yields a negative elapsed and
//    drops out here, so the clock simply hides until the next death re-arms it.
//    Runs exactly ONE cycle and then gives up rather than wrapping; see below.
stock Float:hud_wave_time_f(team, pending) {
    if (team != TEAM_ALLIES && team != TEAM_AXIS) return -1.0;
    if (pending <= 0) return -1.0;

    if (g_has_wave_native) {
        new Float:rem = dodx_get_wave_time(team);
        if (rem >= 0.0) return rem;
    }

    if (!g_pcvar_respawntime || !g_pcvar_clan_match) return -1.0;
    if (get_pcvar_num(g_pcvar_clan_match) == 0)      return -1.0;

    new Float:period = get_pcvar_float(g_pcvar_respawntime);
    if (period <= 0.0) return -1.0;

    new Float:anchor = g_wave_anchor[team];
    if (anchor <= 0.0) return -1.0;

    new Float:elapsed = get_gametime() - anchor;
    if (elapsed < 0.0) return -1.0;

    new Float:rem = (period + WAVE_SPAWN_DELAY) - elapsed;

    // Deliberately does NOT wrap into a second cycle. Still waiting past the
    // deadline means the phase we anchored is no longer trustworthy — the usual
    // cause is a player who died in the last moments before a wave and MISSED it
    // (CBasePlayer::m_imissedwave), which extension mode cannot see. Restarting
    // the countdown from the top puts a confident, fabricated 00:10 on air
    // seconds after it hit zero, which is exactly what a caster reads as the
    // respawn being further away than it is. Hide instead, and wait for the next
    // 0->1 death to re-arm a phase we actually observed.
    if (rem < -WAVE_OVERRUN_GRACE) return -1.0;
    if (rem < 0.0)                 return 0.0;
    return rem;
}

// ─── Territorial scoring tick ────────────────────────────────────────────────

// Control points held by `team` whose DEFAULT owner is somebody else. This is
// the award model's only input: a team banks nothing for sitting on its own
// home flags, and a neutral-default point counts for whoever holds it.
stock non_default_held(team) {
    new n = 0;
    for (new f = 0; f < g_flag_count && f < MAX_FLAGS; f++) {
        if (g_flag_owner[f] == team && g_flag_default_owner[f] != team) n++;
    }
    return n;
}

// Full reset. keep_model=true preserves the learned weight and the grid verdict,
// which are properties of the MAP, not of the current phase — a go-live or a
// round restart re-phases the clock but does not change what a flag is worth.
stock score_tick_reset(bool:keep_model) {
    g_ts_frame_open     = false;
    g_ts_frame_capdirty = false;
    g_ts_frame_gt       = 0.0;
    g_ts_anchor         = 0.0;
    g_ts_cand_gt        = 0.0;
    g_ts_period         = 0.0;
    g_ts_locked         = false;
    g_ts_strikes        = 0;
    g_ts_blind_rolls    = 0;

    if (!keep_model) {
        g_ts_seeded     = false;
        g_ts_last[TEAM_ALLIES] = 0;
        g_ts_last[TEAM_AXIS]   = 0;
        g_ts_w          = 0;
        g_ts_w_streak   = 0;
        g_ts_w_failed   = false;
        g_ts_grid_ok    = true;
        g_ts_grid_seen  = 0;
        g_ts_grid_miss  = 0;
        g_ts_last_cap_gt   = 0.0;
        g_ts_last_reset_gt = 0.0;
    }
}

// Learn W from a confirmed, capture-free tick. Requires exact division AND
// agreement across both teams; any violation latches the numbers off for the
// rest of the map and prints the evidence, so a model that does not hold on an
// unvalidated map self-reports instead of putting a wrong number on air.
stock score_tick_learn(dA, dX, cA, cX) {
    if (g_ts_w_failed) return;

    new bad = 0;
    if (cA == 0 && dA != 0) bad = 1;
    if (cX == 0 && dX != 0) bad = 1;

    new wA = 0, wX = 0;
    if (!bad) {
        if (cA > 0) { if (dA % cA == 0) wA = dA / cA; else bad = 1; }
        if (cX > 0) { if (dX % cX == 0) wX = dX / cX; else bad = 1; }
    }
    if (!bad && wA > 0 && wX > 0 && wA != wX) bad = 1;

    new w = wA ? wA : wX;
    if (!bad && w > 0) {
        if (w < 1 || w > TICK_W_MAX)       bad = 1;
        else if (g_ts_w && w != g_ts_w)    bad = 1;
    }

    if (bad) {
        g_ts_w_failed = true;
        g_ts_w        = 0;
        g_ts_w_streak = 0;
        server_print("[HUD] score-tick: award model VIOLATED at %.2f (dA=%d dX=%d held=%d/%d w=%d) \
— projected points disabled for this map", get_gametime(), dA, dX, cA, cX, g_ts_w);
        return;
    }
    if (w <= 0) return;   // a 0/0 slot teaches nothing

    g_ts_w = w;
    g_ts_w_streak++;
}

// Advance the anchor across slots that produced no visible award.
//
// A silent slot is only EVIDENCE OF A WRONG PHASE when the model said something
// should have been awarded. With both counts zero the award was 0/0, and DoD
// emits no TeamScore at all for that — silence is exactly what we predicted.
// Every half opens with ~3 such slots while both teams sit on their home flags,
// so treating silence as failure would drop the lock every single half.
// The test reads live counts only, so it works before W is known.
stock score_tick_roll(Float:gt) {
    while (g_ts_locked && g_ts_period > 0.0
           && gt > g_ts_anchor + g_ts_period + TICK_OVERRUN_GRACE) {
        if (non_default_held(TEAM_ALLIES) + non_default_held(TEAM_AXIS) != 0) {
            if (++g_ts_strikes >= TICK_MISS_STRIKES) { score_tick_reset(true); return; }
        } else {
            g_ts_strikes = 0;
        }
        if (++g_ts_blind_rolls > TICK_MAX_BLIND_ROLL) { score_tick_reset(true); return; }
        g_ts_anchor += g_ts_period;
    }
}

stock bool:score_tick_on_grid(Float:gt) {
    new Float:q = gt / TICK_GRID_QUANTUM;
    new Float:err = q - float(floatround(q, floatround_round));
    return (floatabs(err) * TICK_GRID_QUANTUM) <= TICK_GRID_TOL;
}

// Classify one closed frame.
stock score_tick_close(Float:gt, dA, dX, cA, cX, bool:capdirty) {
    // Score went backwards: a half or warmup reset. Nothing from before it —
    // including the model — belongs to what follows.
    if (dA < 0 || dX < 0) { score_tick_reset(false); return; }
    if (dA == 0 && dX == 0) return;

    // A round-win bonus (+40 observed) or the half-2 score seeding (+118, the
    // half-1 totals written into gamerules by KTPMatchHandler). Both re-phase
    // the grid; neither is a tick.
    if (dA >= TICK_CAPOUT_FLOOR || dX >= TICK_CAPOUT_FLOOR) {
        g_ts_last_reset_gt = gt;
        score_tick_reset(true);
        return;
    }
    if (gt - g_ts_last_reset_gt < TICK_RESET_WINDOW) return;

    // Grid self-check over the first 12 candidate deltas of the map.
    if (g_ts_grid_ok && g_ts_grid_seen < 12) {
        g_ts_grid_seen++;
        if (!score_tick_on_grid(gt)) g_ts_grid_miss++;
        if (g_ts_grid_seen >= 12 && g_ts_grid_miss >= 12) {
            g_ts_grid_ok = false;
            server_print("[HUD] score-tick: no scoring frame landed on the %.2fs grid \
— falling back to phase-only detection", TICK_GRID_QUANTUM);
        }
    }
    if (g_ts_grid_ok && !score_tick_on_grid(gt)) return;

    if (g_ts_locked && g_ts_period > 0.0) {
        new Float:k = (gt - g_ts_anchor) / g_ts_period;
        new slots   = floatround(k, floatround_round);
        if (slots >= 1
            && floatabs(gt - (g_ts_anchor + float(slots) * g_ts_period)) <= TICK_PHASE_TOL) {
            // Re-measure only from ADJACENT confirmations: a gap spanning a
            // silent slot divides out the very jitter being measured.
            if (slots == 1) g_ts_period = gt - g_ts_anchor;
            g_ts_anchor      = gt;
            g_ts_strikes     = 0;
            g_ts_blind_rolls = 0;
            // A capture-contaminated frame still confirms PHASE, but its delta
            // carries the capture award too, so it must never feed the model
            // and must never be judged a violation.
            if (!capdirty) score_tick_learn(dA, dX, cA, cX);
        }
        // Plausible but off-phase = a capture award. Ignore it.
        return;
    }

    // Bootstrap. A capture-contaminated frame is a bad seed: both its delta and
    // its timing are wrong.
    if (capdirty) return;

    if (g_ts_cand_gt > 0.0) {
        new Float:gap = gt - g_ts_cand_gt;
        if (gap >= TICK_PERIOD_MIN && gap <= TICK_PERIOD_MAX) {
            g_ts_locked      = true;
            g_ts_period      = gap;
            g_ts_anchor      = gt;
            g_ts_strikes     = 0;
            g_ts_blind_rolls = 0;
            // Both frames are real ticks; the candidate's counts were snapshotted
            // at its own frame open. Feeding both saves a period of award latency.
            score_tick_learn(g_ts_cand_d[TEAM_ALLIES], g_ts_cand_d[TEAM_AXIS],
                             g_ts_cand_cnt[TEAM_ALLIES], g_ts_cand_cnt[TEAM_AXIS]);
            score_tick_learn(dA, dX, cA, cX);
            g_ts_cand_gt = 0.0;
            return;
        }
    }

    g_ts_cand_gt = gt;
    g_ts_cand_d[TEAM_ALLIES]   = dA;
    g_ts_cand_d[TEAM_AXIS]     = dX;
    g_ts_cand_cnt[TEAM_ALLIES] = cA;
    g_ts_cand_cnt[TEAM_AXIS]   = cX;
}

// Close the open frame if we have moved past its gametime. Called from both the
// TeamScore handler and the 4 Hz poll, so a frame settles within 250ms without
// a set_task of its own — deliberately, since arming a task from inside a
// message handler is the KTPAMXX shared-SP-forward hazard (see
// arm_cp_reset_window).
stock score_frame_settle() {
    if (!g_ts_frame_open) return;
    if (get_gametime() <= g_ts_frame_gt) return;

    new Float:gt = g_ts_frame_gt;
    new dA = g_ts_frame_hi[TEAM_ALLIES] - g_ts_last[TEAM_ALLIES];
    new dX = g_ts_frame_hi[TEAM_AXIS]   - g_ts_last[TEAM_AXIS];
    new cA = g_ts_frame_cnt[TEAM_ALLIES];
    new cX = g_ts_frame_cnt[TEAM_AXIS];
    new bool:capdirty = g_ts_frame_capdirty;

    g_ts_last[TEAM_ALLIES] = g_ts_frame_hi[TEAM_ALLIES];
    g_ts_last[TEAM_AXIS]   = g_ts_frame_hi[TEAM_AXIS];
    g_ts_frame_open        = false;

    if (!g_ts_seeded) { g_ts_seeded = true; return; }   // first frame is the baseline

    score_tick_close(gt, dA, dX, cA, cX, capdirty);
}

// Accumulate a TeamScore broadcast into the current frame.
stock score_tick_observe(allies, axis) {
    score_frame_settle();

    new Float:gt = get_gametime();
    if (!g_ts_frame_open) {
        g_ts_frame_open     = true;
        g_ts_frame_gt       = gt;
        g_ts_frame_hi[TEAM_ALLIES] = allies;
        g_ts_frame_hi[TEAM_AXIS]   = axis;
        // Snapshot the counts at frame OPEN: a capture landing later in the same
        // instant must not retroactively change what the master was looking at.
        g_ts_frame_cnt[TEAM_ALLIES] = non_default_held(TEAM_ALLIES);
        g_ts_frame_cnt[TEAM_AXIS]   = non_default_held(TEAM_AXIS);
        g_ts_frame_capdirty = (gt - g_ts_last_cap_gt) <= TICK_CAP_PROXIMITY;
    } else {
        if (allies > g_ts_frame_hi[TEAM_ALLIES]) g_ts_frame_hi[TEAM_ALLIES] = allies;
        if (axis   > g_ts_frame_hi[TEAM_AXIS])   g_ts_frame_hi[TEAM_AXIS]   = axis;
    }
}

// Seconds to the next territorial scoring tick; -1.0 when there is no honest
// answer, which the caller surfaces by omitting the whole `scoring` block.
//
// Source preference, mirroring hud_wave_time_f() / hud_timeleft_f():
// 1. dodx_get_score_tick_time() — CLOSED LOOP, straight off the master entity.
//    Correct immediately, across every restart, with no lock-on.
// 2. Observed-phase estimator: anchored on every CONFIRMED tick, period MEASURED
//    from the last two adjacent confirmations. Because it re-anchors each cycle
//    it cannot drift — and it must be measured, not taken from a cvar: the real
//    spacing is 30.50s against an m_iGivePointsDelay of 30, so a cvar-derived
//    estimate would slip half a second every tick.
// 3. -1.0.
//
// Unlike hud_wave_time_f this DOES roll into the next cycle, because here
// silence is a predicted outcome rather than an unobservable failure. The
// no-fabrication rule is kept by the strike and blind-roll bounds instead: the
// countdown never survives TICK_MISS_STRIKES slots that owed a visible award,
// nor TICK_MAX_BLIND_ROLL slots in total, without a fresh confirmation.
stock Float:hud_score_tick_time_f() {
    score_frame_settle();

    if (g_has_score_tick_native) {
        new Float:rem = dodx_get_score_tick_time();
        if (rem >= 0.0) return rem;
    }

    if (!g_ts_locked || g_ts_period <= 0.0) return -1.0;

    new Float:gt = get_gametime();
    if (gt < g_ts_anchor) { score_tick_reset(false); return -1.0; }   // changelevel

    score_tick_roll(gt);
    if (!g_ts_locked) return -1.0;

    new Float:rem = (g_ts_anchor + g_ts_period) - gt;
    if (rem < -TICK_OVERRUN_GRACE) return -1.0;
    if (rem < 0.0)                 return 0.0;
    return rem;
}

// Projected award for `team` on the next tick; -1 = unknown, omit the fields.
stock hud_score_award(team) {
    if (g_ts_w_failed || g_ts_w <= 0)              return -1;
    if (g_ts_w_streak < TICK_W_STREAK_REQ)         return -1;
    if (g_pcvar_score_award
        && get_pcvar_num(g_pcvar_score_award) == 0) return -1;
    return g_ts_w * non_default_held(team);
}

// ─── Broadcast phase ─────────────────────────────────────────────────────────
//
// What part of the match is on screen: warm-up, the go-live countdown, which
// half, halftime, an overtime break, or a finished match. KTPMatchHandler has no
// phase enum, native or cvar to ask — it has three forwards, one coarse native,
// and a localinfo key — so this composes them, and ORDER IS LOAD-BEARING. Each
// numbered rule below exists because of a specific, verified ordering hazard.
//
// Residual, unfixable without an upstream change: an OT round that ends still
// TIED fires NO forward at all (KTPMatchHandler.sma:1005-1049 saves state and
// changelevels), so the few seconds of OT round-end intermission before the map
// change still read `live`. It corrects to `ot_break` on the next map load.
stock compute_phase(out[], olen, mode_out[], mlen) {
    get_localinfo("_ktp_mode", mode_out, mlen);      // "" | "h2" | "ot1" | ...

    // A break mode is only believable under two conditions, and BOTH were caught
    // failing on a real server rather than reasoned into existence:
    //
    //  - Same map. An rcon changelevel away from a pending 2nd half leaves
    //    _ktp_mode set until KTPMatchHandler's next restore pass clears it;
    //    without this the badge reads HALFTIME over unrelated pub play elsewhere.
    //
    //  - No match has ENDED since. KTPMatchHandler clears _ktp_mode in
    //    end_match_cleanup, but that is its promise, not something to depend on:
    //    an abandoned, force-reset or crashed match can leave it set, and the
    //    badge then claims HALFTIME on an idle server forever. Observed exactly
    //    that on the local stack the moment the FINAL hold expired.
    //    g_phase_match_ended_at is cleared only by the next ktp_match_start, so
    //    it marks precisely "the match this mode described is over". A genuine
    //    halftime never trips it — halftime is ktp_half_end, not ktp_match_end.
    new saved_map[64], cur_map[64];
    get_localinfo("_ktp_map", saved_map, charsmax(saved_map));
    get_mapname(cur_map, charsmax(cur_map));
    new bool:break_here = (mode_out[0] != 0)
        && g_phase_match_ended_at == 0
        && equali(saved_map, cur_map);

    // 1. MUST be first. KTPMatchHandler fires ktp_match_end at :896 and only
    //    clears _ktp_mode in end_match_cleanup() at :899 — so when our handler
    //    runs, the mode still reads "h2"/"otN" and rules 4/5 would claim it.
    if (g_phase_match_ended_at > 0
        && get_systime() - g_phase_match_ended_at < POSTMATCH_HOLD_SEC) {
        copy(out, olen, "postmatch");
        return;
    }

    // 2/3. Live on THIS level, with no half boundary since. Beats the mode
    //      because _ktp_mode stays "h2" for the WHOLE of half 2 (KTPMatchHandler
    //      only clears it at match end), which would otherwise read HALFTIME over
    //      live half-2 play. g_awaiting_stat_rewipe is the go-live countdown
    //      window: armed at ktp_match_start, disarmed by the engine's own
    //      mass-respawn burst, i.e. the moment play actually begins.
    if (g_phase_live_this_level) {
        copy(out, olen, g_awaiting_stat_rewipe ? "golive" : "live");
        return;
    }

    // 4. The latch covers the PRE-changelevel halftime window: ktp_half_end fires
    //    at KTPMatchHandler.sma:1092, eleven lines BEFORE set_localinfo(_ktp_mode,
    //    "h2") at :1103, so localinfo alone still reads "" at the instant the
    //    halftime board pops. The mode covers the window after the changelevel,
    //    where plugin_cfg has cleared the latch.
    if (g_phase_halftime_latch || (break_here && mode_out[0] == 'h')) {
        copy(out, olen, "halftime");
        return;
    }

    // 5. Overtime break — only ever reached after the map load, per the residual
    //    noted above.
    if (break_here && mode_out[0] == 'o') {
        copy(out, olen, "ot_break");
        return;
    }

    // 6. Ready-up or pre-start. The native is 1 for live|pending|prestart, and
    //    every live case was claimed by rule 2/3 above, so what's left here is
    //    exactly the window before go-live.
    if (is_match_active()) {
        copy(out, olen, "pregame");
        return;
    }

    // 7. Pub play, or an empty server. The overlay renders no badge at all.
    copy(out, olen, "idle");
}

// Recompute and POST on change, with a forced heartbeat. Change-gated, so it is
// cheap enough to call from any hook: two localinfo reads and a native call when
// nothing has moved.
stock phase_tick() {
    if (!g_cvar_url[0]) return;

    new phase[16], mode[16];
    compute_phase(phase, charsmax(phase), mode, charsmax(mode));

    new now = get_systime();
    new bool:changed = !equal(phase, g_phase_last);
    if (!changed && now - g_phase_last_at < PHASE_HEARTBEAT_SEC) return;

    copy(g_phase_last, charsmax(g_phase_last), phase);
    g_phase_last_at = now;

    // No `half` field — post_event injects one into the envelope and a duplicate
    // key would make the object ambiguous. `mode` rides along so the overlay can
    // name the coming OT round during a break, when `half` still holds the last.
    new json[160];
    formatex(json, charsmax(json),
        "{^"event^":^"match_phase^",^"phase^":^"%s^",^"mode^":^"%s^"}", phase, mode);
    post_event(json);

    if (changed) {
        server_print("[HUD] phase -> %s (mode=%s gt=%.2f)", phase, mode, get_gametime());
    }
}

public task_phase_poll() {
    phase_tick();
}

// Optional-native binding: allow loading against dodx modules that don't export
// dodx_get_round_time (pre-2.7.23) or dodx_get_wave_time (every module shipped
// so far), and against servers with no KTPMatchHandler at all. trap==0 =
// load-time bind failure — mark the native unavailable and
// let the plugin load, falling back to the open-loop estimate. Anything else
// stays fatal: a genuinely missing core native must keep failing loudly, and a
// runtime trap (trap==1) can only mean a gating bug on our side.
public plugin_natives() {
    set_native_filter("native_filter");
}

public native_filter(const name[], index, trap) {
    if (!trap && equal(name, "dodx_get_round_time")) {
        g_has_round_time_native = false;
        return PLUGIN_HANDLED;
    }
    if (!trap && equal(name, "dodx_get_wave_time")) {
        g_has_wave_native = false;
        return PLUGIN_HANDLED;
    }
    if (!trap && equal(name, "dodx_get_score_tick_time")) {
        g_has_score_tick_native = false;
        return PLUGIN_HANDLED;
    }
    if (!trap && equal(name, "dodx_get_score_tick_period")) {
        g_has_score_period_native = false;
        return PLUGIN_HANDLED;
    }
    // Unlike the dodx natives above, this one also swallows the RUNTIME trap
    // (trap==1). PLUGIN_HANDLED makes the call return 0, which is precisely the
    // "no match running" answer the native would have given — so even a gating
    // bug on our side degrades to a dark phase badge rather than aborting the
    // plugin in the middle of a broadcast. Mirrors KTPPracticeMode.sma:198-205.
    if (equal(name, "ktp_is_match_active")) {
        if (!trap) g_has_match_active_native = false;
        return PLUGIN_HANDLED;
    }
    return PLUGIN_CONTINUE;
}

// Never call the native while it's unbound. The filter above would swallow the
// trap anyway; keeping the gate here means one place to reason about it.
stock is_match_active() {
    return g_has_match_active_native ? ktp_is_match_active() : 0;
}

// ─── KTPMatchHandler Forwards ────────────────────────────────────────────────

// half: 1=1st half, 2=2nd half, 101+=OT round
public ktp_match_start(const matchId[], const map[], MatchType:matchType, half) {
    g_matchActive = true;

    // Phase: a match is going live on this level. Clearing the halftime latch
    // here is what ends halftime, and clearing the post-match stamp stops a
    // previous match's FINAL hold from bleeding into this one. The emit itself
    // is at the bottom of this forward, after the roster dump.
    g_phase_live_this_level = true;
    g_phase_halftime_latch  = false;
    g_phase_match_ended_at  = 0;

    // Half-clock anchor with a go-live-countdown offset baked in. This forward fires
    // at the START of the go-live sequence, ~mp_clan_timer BEFORE KTPMatchHandler's
    // `mp_clan_restartround 1` actually rebases the DoD half timer (the round physically
    // restarts + respawns at the end of the countdown). RoundState==1 was meant to mark
    // that edge, but the DoD engine does NOT emit it on prod — KTPMatchHandler itself
    // times out on it every match ("RoundState=1 timeout") and falls through to a 5s
    // fallback (KTPMatchHandler.sma:7924). So msg_round_state's exact re-anchor never
    // fires here, leaving the overlay clock ~8-9s ahead.
    //
    // Fix: project forward by the countdown so the anchor already reflects where the
    // engine WILL rebase. get_gametime() + mp_clan_timer ≈ the real go-live gametime;
    // adding mp_timelimit*60 lands g_half_end_gt on the engine's true half end. The
    // clock then converges to correct as the round goes live (it reads ~mp_clan_timer
    // high during the pre-live countdown, when the client shows a frozen/pre-round HUD
    // anyway). mp_clan_timer is read live (adapts per server/config; DoD default ~10s);
    // guarded to a sane 10s if unset. mp_timelimit is already set for this half/OT round
    // (KTPMatchHandler applies overrides BEFORE the restart, KTPMatchHandler.sma:7857-7884).
    //
    // msg_round_state STILL re-anchors exactly on any server that does emit RoundState==1
    // (overriding this estimate). Phase 2 (a DODX native reading the authoritative DoD
    // round timer) replaces this open-loop estimate with the real value.
    new Float:limit_min = get_cvar_float("mp_timelimit");
    new Float:clan_timer = get_cvar_float("mp_clan_timer");
    if (clan_timer <= 0.0) clan_timer = 10.0;   // DoD default; cvar unset -> fall back
    g_half_end_gt = (limit_min > 0.0) ? get_gametime() + clan_timer + limit_min * 60.0 : 0.0;
    server_print("[HUD] anchor@match_start gt=%.2f half_end_gt=%.2f timelimit=%.1f clan_timer=%.1f",
                 get_gametime(), g_half_end_gt, limit_min, clan_timer);

    copy(g_matchId,  charsmax(g_matchId),  matchId);
    copy(g_matchMap, charsmax(g_matchMap), map);
    g_matchType = _:matchType;
    g_matchHalf = half;

    // Reset per-player kill/death/objscore counters — stats wipe on half start.
    wipe_all_stat_accumulators();
    for (new r = 0; r < SummaryReason; r++) {
        g_lastSummaryAt[r] = 0.0;
    }
    g_lastHalfEndFwdAt = 0.0;

    // Drop wave-clock anchors: the go-live mp_clan_restartround respawns the
    // whole roster, so both sides' clocks go idle and re-arm on the first death
    // of the live half.
    g_wave_anchor[TEAM_ALLIES] = 0.0;
    g_wave_anchor[TEAM_AXIS]   = 0.0;

    // Drop the scoring-tick phase for the same reason — the go-live
    // mp_clan_restartround rebases the control-point master's clock, so the grid
    // we locked during warmup is off-phase for the live half. keep_model: what a
    // flag is worth belongs to the map, not to the phase, and re-learning it
    // would cost three more ticks of dead air on the numbers.
    score_tick_reset(true);

    // Arm the round-live re-anchor + re-wipe. This forward fires ~mp_clan_timer
    // (~8-10s) BEFORE the go-live mp_clan_restartround rebases the half timer, zeroes
    // engine frags and unpauses DODX (RoundState==1). msg_round_state re-anchors the
    // half clock AND re-wipes stats once at that edge, guarded by the deadline. The
    // window must comfortably exceed mp_clan_timer (measured go-live spawn at +10.8s),
    // so 20s — the old 10s deadline could abandon the go-live edge on slower maps,
    // silently losing both the re-anchor and the K/D re-wipe.
    g_awaiting_round_live = true;
    g_round_live_deadline = get_gametime() + 20.0;

    // Arm the go-live STAT re-wipe (separate gate — see the globals). Primary
    // trigger is the engine's mass-respawn burst in dod_client_spawn, which lands
    // exactly on the frag-zeroing edge; this task is the fallback for rosters too
    // small to produce a burst. +2s past the countdown so the burst wins the race
    // on a normal 6v6 and the fallback still fires promptly otherwise.
    g_awaiting_stat_rewipe = true;
    g_golive_spawn_count   = 0;
    g_golive_spawn_t0      = 0.0;
    remove_task(TASK_ID_GOLIVE_REWIPE);
    set_task(clan_timer + 2.0, "task_golive_rewipe", TASK_ID_GOLIVE_REWIPE);

    server_print("[HUD] Match started: %s (map=%s type=%d half=%d)", matchId, map, _:matchType, half);

    // Emit explicit ktp_match_start event so the backend's recorder.startMatch
    // captures match_type/half in metadata.json (auto-start from recordEvent
    // would default both to 0), and the frontend's match-reset handler fires.
    // post_event injects match_id/map/match_type/half into the envelope.
    new json[256];
    formatex(json, charsmax(json),
        "{^"event^":^"ktp_match_start^"}");
    post_event(json);

    // Send half_start event. Fractional timeleft: the frontend anchors its
    // countdown on this value, so integer flooring here adds up to 1s of
    // phase error against the client clock (see Timer.jsx).
    formatex(json, charsmax(json),
        "{^"event^":^"half_start^",^"half^":%d,^"timeleft^":%.2f}",
        half, hud_timeleft_f());
    post_event(json);

    // Seed cumulative team score for the new half. KTPMatchHandler restores
    // 1st-half scores into gamerules via dodx_set_team_score before firing
    // this forward (see KTPMatchHandler.sma:6891), so dodx_get_team_score
    // reads the correct value (0/0 on half 1, carryover on half 2/OT).
    new allies_seed = dodx_get_team_score(TEAM_ALLIES);
    new axis_seed   = dodx_get_team_score(TEAM_AXIS);
    formatex(json, charsmax(json),
        "{^"event^":^"team_score^",^"allies_score^":%d,^"axis_score^":%d}",
        allies_seed, axis_seed);
    post_event(json);

    // Refresh flag state and send roster dump
    do_flags_init("match_start");
    do_roster_dump();

    // "GOING LIVE" — g_awaiting_stat_rewipe is armed above, so this reports the
    // countdown, and do_golive_stat_rewipe flips it to "live" at the engine's
    // own restart edge. Emitted after the roster so the overlay has players to
    // show by the time the caption changes.
    phase_tick();
}

// RoundState message: BYTE arg 1, 1 = round live, anything else = freeze.
// ktp_match_start armed g_awaiting_round_live ~0.8-1s before the round physically
// restarts. When the round actually goes live we re-wipe once, snapping the HUD's
// K/D baseline to the instant the engine zeroes frags and DODX unpauses — so any
// kills that leaked into the go-live window are discarded. Guarded so it fires
// ONLY at go-live: a normal mid-half freeze→live transition (g_awaiting_round_live
// already false) must keep accumulating. PLUGIN_CONTINUE — never block the message
// (it drives the client HUD).
public msg_round_state() {
    if (get_msg_arg_int(1) != 1) return PLUGIN_CONTINUE;   // freeze / pre-round
    if (!g_awaiting_round_live)  return PLUGIN_CONTINUE;    // not a pending go-live

    g_awaiting_round_live = false;

    // Abandon a stale arm: if the go-live RoundState==1 never arrived, don't let a
    // later round boundary erase mid-half stats.
    if (get_gametime() > g_round_live_deadline) {
        return PLUGIN_CONTINUE;
    }

    // Exact stat re-wipe at the true go-live edge. No-op if the spawn burst or
    // the fallback task already observed the restart (which is what happens on
    // prod, where this message never arrives at all).
    do_golive_stat_rewipe("roundstate");

    // Exact re-anchor at the REAL go-live edge. ktp_match_start baked in an
    // mp_clan_timer estimate of this moment; if the engine actually emits RoundState==1
    // (it does NOT on current prod — see the ktp_match_start note — but may on other
    // configs/builds) we replace the estimate with the precise value: the round is now
    // truly live and the engine just rebased the timer, so recompute from the current
    // gametime. This is the same edge KTPMatchHandler trusts for "round is truly live".
    // mp_timelimit is unchanged since go-live.
    new Float:limit_min = get_cvar_float("mp_timelimit");
    if (limit_min > 0.0) {
        g_half_end_gt = get_gametime() + limit_min * 60.0;
        server_print("[HUD] anchor@round_live gt=%.2f half_end_gt=%.2f timelimit=%.1f",
                     get_gametime(), g_half_end_gt, limit_min);
        // This IS the confirmed go-live rebase — void the artifact-guard
        // baseline so the native's legitimate jump from the countdown value to
        // the fresh full half can't pattern-match the end-of-half artifact
        // (g_awaiting_round_live is already false here, so hud_timeleft_f's
        // in_golive exemption no longer applies to this call).
        g_last_native_rem = -1.0;
        g_native_hold_until = 0.0;
        // Re-emit the corrected clock immediately so the frontend snaps to it instead
        // of waiting up to 30s for the next task_time_sync. time_sync rides the same
        // HLTV delay buffer as kills (stays footage-aligned); half_start is avoided
        // because it re-triggers the frontend's boundary/reset logic.
        new tsjson[128];
        formatex(tsjson, charsmax(tsjson),
            "{^"event^":^"time_sync^",^"timeleft^":%.2f}", hud_timeleft_f());
        post_event(tsjson);
    }

    return PLUGIN_CONTINUE;
}

public ktp_match_end(const matchId[], const map[], MatchType:matchType, team1Score, team2Score) {
    server_print("[HUD] Match ended: %s (allies=%d axis=%d)", matchId, team1Score, team2Score);

    // Final stats snapshot — must precede the ktp_match_end event below:
    // the backend closes the match (recorder.endMatch) when it sees
    // ktp_match_end, and the summary needs to land inside events.jsonl.
    // This fires for EVERY terminal path in KTPMatchHandler (normal end,
    // OT win/limit, abandons, forfeits).
    emit_stats_summary(SUMMARY_MATCH_END);

    // Emit BEFORE clearing g_matchActive so post_event() still injects match_id/map.
    // Event name must match the backend's lifecycle handler in ingest.ts (which
    // calls recorder.endMatch on ktp_match_end) — see backend/src/handler/ingest.ts.
    new json[256];
    formatex(json, charsmax(json),
        "{^"event^":^"ktp_match_end^",^"allies_score^":%d,^"axis_score^":%d}",
        team1Score, team2Score);
    post_event(json);

    g_matchActive = false;
    g_matchId[0] = '^0';
    g_half_end_gt = 0.0;
    // Clear the native jump-detector too: if the post-match changelevel stalls
    // (KTPMatchHandler has 15s watchdogs for exactly that), a time_sync in the
    // limbo window must not trigger the artifact hold off dead-half state.
    g_last_native_rem = -1.0;
    g_native_hold_until = 0.0;

    // "FINAL", held for POSTMATCH_HOLD_SEC. systime, not gametime: the post-match
    // changelevel is seconds away and resets gametime to ~0, which would make a
    // gametime deadline either expire instantly or never.
    //
    // Note the phase POST rides the normal envelope, which is emitted AFTER
    // g_matchActive went false above — so unlike the ktp_match_end event, it
    // carries no match_id. That is fine and deliberate: the backend keys the
    // state cache on the server hostname, not the match.
    g_phase_live_this_level = false;
    g_phase_halftime_latch  = false;
    g_phase_match_ended_at  = get_systime();
    phase_tick();
}

// ─── Half End (KTPMatchHandler ktp_half_end forward) ─────────────────────────

// KTPMatchHandler fires ktp_half_end(matchId[], map[], matchType, half, team1Score,
// team2Score) from handle_first_half_end() at the moment 1st-half gameplay ends,
// BEFORE the changelevel — so our half-scoped accumulators (damage matrix, kills,
// caps) are still intact for an authoritative summary.
//
// Why a forward and not plugin_log: KTPMatchHandler also writes a `KTP_HALF_END`
// log line, but AMXX plugin_log / register_logevent do NOT fire in KTPAMXX
// extension mode (no Metamod log hook), so the old log-line handler here emitted
// NOTHING in production — the halftime board never had a source. The forward is
// the same proven path ktp_match_start/ktp_match_end use. amxxcurl is process-
// lifetime, so these POSTs survive the imminent map change.
//
// half is always 1 (1st-half end is the only half boundary with a pre-changelevel
// signal; 2nd-half/OT terminal paths are covered by ktp_match_end). team1/team2 are
// the just-saved 1st-half scores (team1=Allies, team2=Axis in the 1st half). The 2s
// guard mirrors emit_stats_summary's dedupe so a double changelevel-hook fire emits
// the marker once.
public ktp_half_end(const matchId[], const map[], MatchType:matchType, half, team1Score, team2Score) {
    new Float:now = get_gametime();
    if (g_lastHalfEndFwdAt > 0.0 && now - g_lastHalfEndFwdAt < 2.0) return;
    g_lastHalfEndFwdAt = now;

    server_print("[HUD] ktp_half_end forward (%s half=%d %d-%d) — emitting half_end + stats summary",
                 matchId, half, team1Score, team2Score);

    new json[160];
    formatex(json, charsmax(json),
        "{^"event^":^"half_end^",^"half^":%d,^"allies_score^":%d,^"axis_score^":%d}",
        half, team1Score, team2Score);
    post_event(json);

    emit_stats_summary(SUMMARY_HALF_END);

    // The half is over — clear the anchor so it can't go stale across the
    // halftime changelevel (plugin globals survive changelevel; the old-half
    // anchor was meaningless on the new map's gametime and spammed the drift
    // print through every half-2 warmup, and was a wrong fallback if the
    // native failed in that window). ktp_match_start re-seeds it for half 2.
    // The jump-detector state goes with it: if the changelevel stalls (15s
    // KTPMatchHandler watchdogs), a limbo-window time_sync must not trigger
    // the artifact hold off the dead half's near-zero baseline.
    g_half_end_gt = 0.0;
    g_last_native_rem = -1.0;
    g_native_hold_until = 0.0;

    // "HALFTIME". The latch is required, not merely convenient: KTPMatchHandler
    // sets _ktp_mode="h2" at :1103, ELEVEN LINES after firing this forward at
    // :1092, so the localinfo still reads "" right now. The latch covers this
    // pre-changelevel window; _ktp_mode covers the post-changelevel one after
    // plugin_cfg clears the latch. Clearing live_this_level is what stops the
    // caption saying "1ST HALF" over the halftime board — g_matchActive stays
    // true through all of this and cannot be used for it.
    //
    // This emit lands in the same pre-changelevel tail as the halftime board, so
    // the backend treats match_phase as a board event in the HLTV delay buffer;
    // without that it could announce HALFTIME ahead of the footage.
    g_phase_live_this_level = false;
    g_phase_halftime_latch  = true;
    phase_tick();
}

// ─── Roster Dump ─────────────────────────────────────────────────────────────

// Send player_connect + roster_player + player_score for every connected
// on-team player. roster_player carries alive/dead/health/class/weapons —
// distinct from player_spawn (which means "just respawned at 100 HP"), so
// the HUD doesn't lie about a fresh spawn for a currently-dead player.
stock do_roster_dump() {
    new maxp = get_maxplayers();

    for (new id = 1; id <= maxp; id++) {
        if (!is_user_connected(id)) continue;
        if (is_user_hltv(id)) continue;

        new team = get_user_team(id);
        if (team != TEAM_ALLIES && team != TEAM_AXIS) continue;

        new steamid[32], name[64], name_esc[128], team_str[16];
        get_steamid(id, steamid, charsmax(steamid));
        get_user_name(id, name, charsmax(name));
        escape_json(name, name_esc, charsmax(name_esc));
        get_team_str(team, team_str, charsmax(team_str));

        g_player_team[id] = team;

        new json[384];
        formatex(json, charsmax(json),
            "{^"event^":^"player_connect^",^"user_id^":^"%s^",^"name^":^"%s^",^"team^":^"%s^"}",
            steamid, name_esc, team_str);
        post_event(json);

        new bool:alive = is_user_alive(id) ? true : false;
        new class_id = alive ? dod_get_user_class(id) : -1;
        new wpn_primary[32], wpn_secondary[32];
        if (alive) {
            get_wpn_name_for_slot(id, DODWT_PRIMARY,   wpn_primary,   charsmax(wpn_primary));
            get_wpn_name_for_slot(id, DODWT_SECONDARY, wpn_secondary, charsmax(wpn_secondary));
        } else {
            copy(wpn_primary,   charsmax(wpn_primary),   "none");
            copy(wpn_secondary, charsmax(wpn_secondary), "none");
        }
        new health = alive ? get_user_health(id) : 0;

        g_player_prone[id] = PRONE_STANDING;
        g_player_alive[id] = alive ? 1 : 0;
        // Re-seed the applied-damage baseline. ktp_match_start wipes every slot
        // (wipe_all_stat_accumulators) immediately before this dump, so without
        // this everyone alive across the go-live restart would run client_damage's
        // fallback on their first hit of the half.
        g_last_health[id]  = alive ? health : 0;

        formatex(json, charsmax(json),
            "{^"event^":^"roster_player^",^"user_id^":^"%s^",^"name^":^"%s^",^"team^":^"%s^",^"alive^":%s,^"class_id^":%d,^"weapon_primary^":^"%s^",^"weapon_secondary^":^"%s^",^"health^":%d}",
            steamid, name_esc, team_str, alive ? "true" : "false", class_id, wpn_primary, wpn_secondary, health);
        post_event(json);

        // Push a zeroed player_score so the HUD scoreboard reads 0/0/0/0 from
        // the moment the match starts, instead of waiting for the first kill.
        emit_player_score(id);
    }
}

// ─── Round Events ────────────────────────────────────────────────────────────

public ev_round_start() {
    new json[128];
    formatex(json, charsmax(json),
        "{^"event^":^"round_start^",^"timeleft^":%.2f}", hud_timeleft_f());
    post_event(json);

    // Refresh flag state on round start. Authoritative: the engine has just reset
    // every CP to its default. (This logevent is dead in DoD — see the registration
    // comment — but the reason is correct for the configs where it does fire.)
    do_flags_init("reset");
}

public ev_round_end() {
    // dodx_get_team_score reads gamerules directly. The legacy dod_get_team_score
    // reads DODX's message-tracked globals, which sit at 0 in extension mode
    // because Client_TeamScore broadcasts don't reach DODX. See
    // KTPMatchHandler/Technical_Guide.md:1286 + dodx.inc:275-282.
    new allies = dodx_get_team_score(TEAM_ALLIES);
    new axis   = dodx_get_team_score(TEAM_AXIS);

    new winner[16];
    if (allies > axis)      copy(winner, charsmax(winner), "allies");
    else if (axis > allies) copy(winner, charsmax(winner), "axis");
    else                    copy(winner, charsmax(winner), "draw");

    // Classify how the round ended. Schema: objectives | time_limit |
    // allies_eliminated | axis_eliminated. Read from state we already cache —
    // no new DODX calls.
    new end_type[20];
    classify_round_end(end_type, charsmax(end_type));

    new json[256];
    formatex(json, charsmax(json),
        "{^"event^":^"round_end^",^"winner^":^"%s^",^"end_type^":^"%s^",^"allies_score^":%d,^"axis_score^":%d}",
        winner, end_type, allies, axis);
    post_event(json);

    emit_stats_summary(SUMMARY_ROUND_END);
}

stock classify_round_end(out[], len) {
    // Capout: every flag owned by one team. Check before time_limit because
    // a team can capout exactly as the timer hits 0.
    if (g_flag_count > 0) {
        new bool:all_allies = true;
        new bool:all_axis   = true;
        for (new f = 0; f < g_flag_count && f < MAX_FLAGS; f++) {
            if (g_flag_owner[f] != TEAM_ALLIES) all_allies = false;
            if (g_flag_owner[f] != TEAM_AXIS)   all_axis   = false;
        }
        if (all_allies || all_axis) {
            copy(out, len, "objectives");
            return;
        }
    }

    // Elimination: every alive on-team player has been killed. We track alive
    // state via DODX client_spawn / client_death — count survivors per team.
    new allies_alive = 0, axis_alive = 0;
    for (new id = 1; id <= MAX_PLAYERS; id++) {
        if (!g_player_alive[id]) continue;
        if (g_player_team[id] == TEAM_ALLIES) allies_alive++;
        else if (g_player_team[id] == TEAM_AXIS) axis_alive++;
    }
    // Only treat as elimination if the *other* team had players to begin with —
    // a half that starts with one team unfilled isn't a wipe.
    if (allies_alive == 0 && axis_alive > 0) {
        copy(out, len, "allies_eliminated");
        return;
    }
    if (axis_alive == 0 && allies_alive > 0) {
        copy(out, len, "axis_eliminated");
        return;
    }

    // Time limit if the half clock has run out.
    if (hud_timeleft() <= 0) {
        copy(out, len, "time_limit");
        return;
    }

    // Default — covers mp_pointlimit hits and anything we don't classify.
    // All score-driven, fold into the same bucket as capouts.
    copy(out, len, "objectives");
}

// ─── Player Events ───────────────────────────────────────────────────────────

public client_authorized(id) {
    if (is_user_hltv(id)) return;

    new steamid[32], name[64], name_esc[128], team_str[16];

    get_steamid(id, steamid, charsmax(steamid));
    get_user_name(id, name, charsmax(name));
    escape_json(name, name_esc, charsmax(name_esc));

    // Player isn't fully in-game yet — always starts unassigned
    get_team_str(TEAM_UNASSIGNED, team_str, charsmax(team_str));

    g_player_team[id]   = TEAM_UNASSIGNED;
    g_player_prone[id]  = PRONE_STANDING;
    g_player_alive[id]  = 0;
    g_player_kills[id]    = 0;
    g_player_deaths[id]   = 0;
    g_player_objscore[id] = 0;
    reset_player_stats_slot(id);

    new json[256];
    formatex(json, charsmax(json),
        "{^"event^":^"player_connect^",^"user_id^":^"%s^",^"name^":^"%s^",^"team^":^"%s^"}",
        steamid, name_esc, team_str);
    post_event(json);

    // Wedge-immune phase refresh. The ready-up window is the one phase with no
    // forward behind it, so it depends on the 2s poll — and repeating tasks can
    // wedge through half 1 on prod. Roster churn is exactly what precedes a
    // ready-up, and these are DODX forwards, so they always run. Change-gated:
    // this costs two localinfo reads when nothing has moved.
    phase_tick();
}

public client_disconnect(id) {
    if (is_user_hltv(id)) return;

    new steamid[32];
    get_steamid(id, steamid, charsmax(steamid));

    new json[128];
    formatex(json, charsmax(json),
        "{^"event^":^"player_disconnect^",^"user_id^":^"%s^"}", steamid);
    post_event(json);

    g_player_team[id]   = 0;
    g_player_prone[id]  = PRONE_STANDING;
    g_player_alive[id]  = 0;
    g_player_kills[id]    = 0;
    g_player_deaths[id]   = 0;
    g_player_objscore[id] = 0;
    reset_player_stats_slot(id);

    // See client_authorized — wedge-immune phase refresh.
    phase_tick();
}

// DODX forward: player spawned
public dod_client_spawn(id) {
    if (is_user_hltv(id)) return;
    if (!is_user_alive(id)) return;

    // Go-live restart edge: the engine respawns the whole roster in one frame when
    // the mp_clan_timer countdown ends and it zeroes frags. That burst is our only
    // reliable marker of the edge (RoundState==1 never arrives on prod), so use it
    // to re-wipe the countdown's leaked kills. Mid-countdown waves are 2-3 players,
    // well under GOLIVE_SPAWN_BURST, so they can't trip this early.
    if (g_awaiting_stat_rewipe) {
        new Float:now = get_gametime();
        if (now - g_golive_spawn_t0 > GOLIVE_BURST_WINDOW) {
            g_golive_spawn_t0    = now;   // start a fresh burst window
            g_golive_spawn_count = 1;
        } else {
            g_golive_spawn_count++;
        }
        if (g_golive_spawn_count >= GOLIVE_SPAWN_BURST) {
            do_golive_stat_rewipe("spawn_burst");
        }
    }

    new steamid[32], name[64], name_esc[128], team_str[16], wpn_primary[32], wpn_secondary[32];
    get_steamid(id, steamid, charsmax(steamid));
    get_user_name(id, name, charsmax(name));
    escape_json(name, name_esc, charsmax(name_esc));

    new team     = get_user_team(id);
    new class_id = dod_get_user_class(id);
    get_team_str(team, team_str, charsmax(team_str));

    get_wpn_name_for_slot(id, DODWT_PRIMARY,   wpn_primary,   charsmax(wpn_primary));
    get_wpn_name_for_slot(id, DODWT_SECONDARY, wpn_secondary, charsmax(wpn_secondary));

    g_player_team[id]  = team;
    g_player_prone[id] = PRONE_STANDING;
    g_player_alive[id] = 1;
    // Fresh life at full health — the baseline every applied-damage clamp in
    // client_damage measures against.
    g_last_health[id]  = get_user_health(id);

    // Fresh life — clear damage taken so assist credit only spans one life.
    for (new a = 0; a <= MAX_PLAYERS; a++) {
        g_dmg_taken[id][a] = 0;
    }

    new json[384];
    formatex(json, charsmax(json),
        "{^"event^":^"player_spawn^",^"user_id^":^"%s^",^"name^":^"%s^",^"team^":^"%s^",^"class_id^":%d,^"weapon_primary^":^"%s^",^"weapon_secondary^":^"%s^",^"health^":100}",
        steamid, name_esc, team_str, class_id, wpn_primary, wpn_secondary);
    post_event(json);

    // Reset prone on respawn
    do_prone_change(id, PRONE_STANDING);
}

// DODX forward: team change
public dod_client_changeteam(id, team, oldteam) {
    if (is_user_hltv(id)) return;

    new steamid[32], team_str[16];
    get_steamid(id, steamid, charsmax(steamid));
    get_team_str(team, team_str, charsmax(team_str));

    g_player_team[id] = team;

    new json[128];
    formatex(json, charsmax(json),
        "{^"event^":^"player_team_change^",^"user_id^":^"%s^",^"team^":^"%s^"}",
        steamid, team_str);
    post_event(json);

    // See client_authorized — wedge-immune phase refresh. Players picking sides
    // is the strongest signal that a ready-up is about to happen.
    phase_tick();
}

// DODX forward: client_damage (fires on every hit)
//
// `damage` here is what dodx reported: (int)pev->dmg_take, the RAW amount the
// game DLL charged, post-dod_damage_pre but NEVER clamped to the victim's
// remaining health. Crediting it verbatim banked the killing blow's overkill —
// a 120-damage garand hit on a 40 HP victim scored 120.
//
// We credit APPLIED damage: the health the victim actually lost, capped at what
// dodx reported. `pre` is the previous hit's post-hit health (seeded at spawn and
// at the roster dump); `victim_health` is this hit's, which goes negative on
// overkill.
//
//     applied = min(damage, max(0, pre - max(victim_health, 0)))
//
// The min() is what makes this survive KTPGrenadeDamage, which IS deployed
// fleet-wide and reduces grenade damage through dodx's dod_damage_pre heal-back.
// On a RAW-lethal grenade hit dodx skips the heal-back (it gates on the victim
// still being alive) but still forwards the REDUCED number, so victim_health sits
// further below zero than the reported damage explains. A naive
// `damage + min(victim_health, 0)` would under-report there, sometimes to 0;
// capping the health drop at `damage` credits the reduced hit in full and never
// more than dodx said.
//
// Fallback when the baseline is missing or desynced (pre <= 0, or pre < the
// post-hit read, meaning the victim gained health we never observed): take
// post + damage as the pre-hit health, which degrades to the naive form — exact
// whenever the engine applied the reported number unmodified. Validated on all
// 1086 damage events of the NY1 fixture: victim_health + damage always lands in
// (0,100], so pre-hit health is reliably recoverable.
public client_damage(attacker, victim, damage, wpnindex, hitplace, TK) {
    if (attacker < 1 || attacker > MAX_PLAYERS) return;
    if (victim < 1 || victim > MAX_PLAYERS) return;

    // POST-hit health — negative on overkill. Read BEFORE anything is credited.
    new victim_health = get_user_health(victim);

    new pre = g_last_health[victim];
    if (pre <= 0 || pre < victim_health) pre = victim_health + damage;
    new applied = min(damage, max(0, pre - max(victim_health, 0)));

    // Keep the baseline in sync for EVERY hit. Self-damage, fall damage and team
    // hits all move the victim's health even though they credit nothing, so this
    // MUST stay outside the accumulate gate below — inside it, the next enemy hit
    // reads a stale-high `pre` and silently over-reports again.
    g_last_health[victim] = victim_health;

    // Accumulate enemy damage only — self-damage and team hits earn nothing.
    // Matrix row feeds assist attribution at client_death, on the SAME applied
    // value so the 50-damage assist threshold measures what the board shows.
    if (attacker != victim && !TK) {
        g_dmg_taken[victim][attacker] += applied;
        g_player_damage[attacker] += applied;
        g_player_hits[attacker]++;
        if (hitplace == 1) g_player_hs_hits[attacker]++;
    }

    new attacker_steam[35], victim_steam[35], weapon[32];
    get_steamid(attacker, attacker_steam, charsmax(attacker_steam));
    get_steamid(victim, victim_steam, charsmax(victim_steam));
    xmod_get_wpnlogname(wpnindex, weapon, charsmax(weapon));

    // `damage` on the wire is the APPLIED number (what the accumulators bank);
    // `damage_raw` preserves dodx's report so a post-deploy capture can be audited
    // against the pre-2.5.0 streams without a second build.
    new json[512];
    formatex(json, charsmax(json),
        "{^"event^":^"damage^",^"attacker_id^":^"%s^",^"victim_id^":^"%s^",^"damage^":%d,^"damage_raw^":%d,^"weapon^":^"%s^",^"hitplace^":%d,^"victim_health^":%d}",
        attacker_steam, victim_steam, applied, damage, weapon, hitplace, victim_health);
    post_event(json);
}

// DODX forward: client_death
public client_death(killer, victim, wpnindex, hitplace, TK) {
    if (victim < 1 || victim > MAX_PLAYERS) return;

    new killer_steamid[32], victim_steamid[32], weapon[32];

    // World kills (falling, team-switch) send killer=0
    if (killer < 1 || killer > MAX_PLAYERS) killer = victim;

    get_steamid(killer, killer_steamid, charsmax(killer_steamid));
    get_steamid(victim, victim_steamid, charsmax(victim_steamid));
    xmod_get_wpnlogname(wpnindex, weapon, charsmax(weapon));

    new kill_type[16];
    if (killer == victim) {
        copy(kill_type, charsmax(kill_type), "suicide");
    } else if (TK) {
        copy(kill_type, charsmax(kill_type), "teamkill");
    } else {
        copy(kill_type, charsmax(kill_type), "normal");
    }

    new bool:headshot = (hitplace == 1);
    new victim_prone = (g_player_prone[victim] != PRONE_STANDING) ? 1 : 0;
    new killer_prone = (g_player_prone[killer] != PRONE_STANDING) ? 1 : 0;
    new bool:nade_kill = is_nade_wpn(wpnindex);

    // Reinforcement-wave phase anchor. DoD's wave clock is idle while a team has
    // nobody waiting and starts at the death that takes it from 0 waiting to 1,
    // so that transition IS the phase. Evaluated BEFORE the victim is marked
    // dead, hence pending == 0 here means this death armed the clock.
    //
    // Re-anchoring on every 0->1 transition (rather than only when the stored
    // value is empty) is what makes this self-correcting: a stale anchor from an
    // earlier round, half or map can never survive a lull, so no separate
    // invalidation path has to be kept in sync with every restart edge.
    new victim_team = g_player_team[victim];
    if ((victim_team == TEAM_ALLIES || victim_team == TEAM_AXIS)
        && wave_pending(victim_team) == 0) {
        g_wave_anchor[victim_team] = get_gametime();
    }

    g_player_alive[victim] = 0;
    g_player_prone[victim] = PRONE_STANDING;
    g_last_health[victim]  = 0;   // life over — dod_client_spawn re-seeds it

    // Bump the teamkiller's running TK count BEFORE building the kill JSON so
    // the kill feed can surface it (e.g. "Polak (TK x2)"). Counted per half.
    if (killer != victim && TK && is_user_connected(killer)) {
        g_player_teamkills[killer]++;
    }

    // Assists: anyone (not killer, not victim) who dealt 50+ enemy damage to
    // the victim this life. The matrix only ever holds enemy damage, so the
    // team check is belt-and-braces for mid-life team switches. Enemies who
    // forced a suicide/TK/world death still earn the assist.
    static assist_json[512];
    assist_json[0] = '^0';
    new assist_ids[MAX_PLAYERS], assist_count = 0;
    for (new a = 1; a <= MAX_PLAYERS; a++) {
        if (a == killer || a == victim) continue;
        if (g_dmg_taken[victim][a] < ASSIST_DAMAGE_THRESHOLD) continue;
        if (!is_user_connected(a)) continue;
        if (g_player_team[a] == g_player_team[victim]) continue;
        // Whole entries only — a truncated steamid would break the JSON.
        if (strlen(assist_json) > charsmax(assist_json) - 48) break;

        new assist_steamid[32], abuf[48];
        get_steamid(a, assist_steamid, charsmax(assist_steamid));
        formatex(abuf, charsmax(abuf), "%s^"%s^"", assist_count > 0 ? "," : "", assist_steamid);
        add(assist_json, charsmax(assist_json), abuf);
        assist_ids[assist_count++] = a;
    }

    // Victim's life is over — clear their damage-taken row.
    for (new a = 0; a <= MAX_PLAYERS; a++) {
        g_dmg_taken[victim][a] = 0;
    }

    new json[1024];
    formatex(json, charsmax(json),
        "{^"event^":^"kill^",^"killer_id^":^"%s^",^"victim_id^":^"%s^",^"weapon^":^"%s^",^"kill_type^":^"%s^",^"kill_class^":^"%s^",^"headshot^":%s,^"victim_prone^":%s,^"killer_prone^":%s,^"killer_tk_count^":%d,^"assist_ids^":[%s]}",
        killer_steamid, victim_steamid, weapon, kill_type,
        nade_kill ? "nade" : "gun",
        headshot ? "true" : "false",
        victim_prone ? "true" : "false",
        killer_prone ? "true" : "false",
        g_player_teamkills[killer],
        assist_json);
    post_event(json);

    // Track kill/death counts locally and emit player_score for both players.
    // The engine's ScoreShort broadcast on death is unreliable in extension mode
    // (KTPAMXX + ReHLDS + dproto) — pure-victim players ended up with deaths=0
    // on late-join snapshots in prod. v.frags is also off-by-one here because
    // DODX's Damage-hook path fires client_death BEFORE CDODPlayer::Killed()
    // increments frags / deaths. So track both locally and emit explicitly.
    //
    // Killer: +1 normal kill; teamkills and suicides score NOTHING.
    //
    // We used to decrement on a TK, assuming DoD's frag semantics penalise it.
    // The engine does NOT — prod-verified 2026-07-19 on 1784509712-ATL1, where
    // nomistizzle's mid-half TK left the in-game scoreboard at 11 kills while the
    // HUD showed 10. Decrementing put the overlay permanently BELOW the real
    // scoreboard for anyone who TK'd, for the rest of the half. The teamkill is
    // still tracked and surfaced separately via g_player_teamkills (kill feed).
    if (killer != victim && is_user_connected(killer)) {
        if (!TK) {
            g_player_kills[killer]++;
            // HS / nade-vs-gun buckets count normal kills only, matching frag
            // semantics — a TK'd headshot shouldn't pad anyone's HS%.
            if (headshot)  g_player_hs_kills[killer]++;
            if (nade_kill) g_player_nade_kills[killer]++;
            else           g_player_gun_kills[killer]++;
            // Kill streak (normal kills only); track the half's best.
            g_player_cur_streak[killer]++;
            if (g_player_cur_streak[killer] > g_player_best_streak[killer]) {
                g_player_best_streak[killer] = g_player_cur_streak[killer];
            }
        }
        emit_player_score(killer);
    }

    // Victim: count every death (suicides included — DoD scoreboard does too).
    // Death breaks the victim's current streak (best is preserved).
    if (is_user_connected(victim)) {
        g_player_deaths[victim]++;
        g_player_cur_streak[victim] = 0;
        emit_player_score(victim);
    }

    // Assisters: bump and emit so the HUD updates without waiting for their
    // next kill (same pattern as the cap credit in dod_score_event).
    for (new i = 0; i < assist_count; i++) {
        g_player_assists[assist_ids[i]]++;
        emit_player_score(assist_ids[i]);
    }

    // Cap-break candidate. If the victim's team was actively capping a flag, an
    // enemy kill MAY have removed a capper from the point. Queue the killer;
    // task_poll_zones credits queued killers as the capping team's in-zone count
    // drops below the baseline — i.e. the victim was on the point, not merely on
    // the capping team. The engine applies the death decrement 0.2–2.5s late
    // (prod-measured), hence the queue + window instead of a one-shot snapshot.
    // dod_control_point_captured clears the queue if the cap then succeeds
    // (a completed cap is not a break).
    if (killer != victim && !TK && is_user_connected(killer)) {
        new vt = g_player_team[victim];
        if (vt == TEAM_ALLIES || vt == TEAM_AXIS) {
            for (new f = 0; f < g_flag_count && f < MAX_FLAGS; f++) {
                if (g_flag_capping_team[f] != vt) continue;
                if (g_break_q_count[f] > 0 && g_break_team[f] != vt) {
                    // Capping team flipped while the previous team's queue was
                    // still draining. The flip means the old cap already
                    // stopped, so those candidates are stale — re-latch for
                    // the live cap instead of dropping the fresh candidate.
                    break_queue_clear(f);
                }
                if (g_break_q_count[f] == 0) {
                    // First candidate: latch the team and the drop baseline as
                    // min(fresh read, prev-poll cache). The fresh read can
                    // already include an EARLIER victim's late decrement (the
                    // cache corrects that); the cache misses a sub-poll
                    // voluntary walk-off (the fresh read corrects that). The
                    // lower of the two never over-credits.
                    // `f` is a DLL cp_index (g_flag_capping_team is DLL-indexed),
                    // so the dodx area read must go through the remap.
                    new fresh = dodx_area_get_data(g_cp_dodx_of_dll[f], (vt == TEAM_ALLIES) ? CA_num_allies : CA_num_axis);
                    new cached = (vt == TEAM_ALLIES) ? g_flag_prev_allies_count[f] : g_flag_prev_axis_count[f];
                    g_break_team[f]     = vt;
                    g_break_baseline[f] = (fresh < cached) ? fresh : cached;
                }
                if (g_break_q_count[f] < BREAK_QUEUE_MAX) {
                    new qi = g_break_q_count[f];
                    g_break_q_killer[f][qi] = killer;
                    g_break_q_ttl[f][qi]    = BREAK_WINDOW_POLLS;
                    g_break_q_count[f]++;
                }
                break;  // attribute at most one flag per kill (first active cap by victim's team)
            }
        }
    }
}

stock emit_player_score(id) {
    new steamid[32];
    get_steamid(id, steamid, charsmax(steamid));

    new kills    = g_player_kills[id];
    new deaths   = g_player_deaths[id];
    new score    = dod_get_user_score(id);
    new objscore = g_player_objscore[id];

    new json[512];
    formatex(json, charsmax(json),
        "{^"event^":^"player_score^",^"user_id^":^"%s^",^"kills^":%d,^"deaths^":%d,^"score^":%d,^"obj_score^":%d,^"damage^":%d,^"assists^":%d,^"hs_kills^":%d,^"nade_kills^":%d,^"gun_kills^":%d,^"hits^":%d,^"hs_hits^":%d,^"caps^":%d,^"cap_breaks^":%d,^"best_streak^":%d}",
        steamid, kills, deaths, score, objscore,
        g_player_damage[id], g_player_assists[id], g_player_hs_kills[id],
        g_player_nade_kills[id], g_player_gun_kills[id],
        g_player_hits[id], g_player_hs_hits[id],
        g_player_caps[id], g_player_cap_breaks[id], g_player_best_streak[id]);
    post_event(json);
}

// One batched stats snapshot for every connected on-team player. Fired at
// discrete boundaries only (capout / half end / match end / rcon) — never from
// a repeating task, so it stays immune to the half-1 changelevel wedge. The
// per-reason dedupe collapses double triggers (e.g. capout + ev_round_end for
// the same round).
// capout_team / capout_by are only meaningful for SUMMARY_ROUND_END (a full
// capout): they title the board "ALLIES CAPOUT BY <names>". capout_by must
// already be JSON-escaped by the caller (build_captor_names does this).
stock emit_stats_summary(reason, const capout_team[] = "", const capout_by[] = "") {
    if (!g_cvar_url[0]) return;

    new Float:now = get_gametime();
    if (g_lastSummaryAt[reason] > 0.0 && now - g_lastSummaryAt[reason] < 2.0) return;
    g_lastSummaryAt[reason] = now;

    static json[BUFFER_SIZE];
    if (capout_team[0]) {
        formatex(json, charsmax(json),
            "{^"event^":^"player_stats_summary^",^"reason^":^"%s^",^"capout_team^":^"%s^",^"capout_by^":^"%s^",^"players^":[",
            g_summaryReasonStr[reason], capout_team, capout_by);
    } else {
        formatex(json, charsmax(json),
            "{^"event^":^"player_stats_summary^",^"reason^":^"%s^",^"players^":[",
            g_summaryReasonStr[reason]);
    }

    new maxp = get_maxplayers();
    new bool:first = true;
    for (new id = 1; id <= maxp && id <= MAX_PLAYERS; id++) {
        if (!is_user_connected(id)) continue;
        if (is_user_hltv(id)) continue;

        // Use the plugin-tracked team, NOT the live get_user_team(id). At the
        // end-of-match intermission the engine team read returns non-ALLIES/AXIS
        // for everyone, which silently dropped every row and emitted an empty
        // match_end board (confirmed on 1783044529-ATL1). g_player_team is set on
        // spawn/team-change and persists through intermission until disconnect.
        new team = g_player_team[id];
        if (team != TEAM_ALLIES && team != TEAM_AXIS) continue;

        // Whole entries only. Reserve room for this player's row (<=512) PLUS
        // post_event's envelope prefix, which rides on the SAME BUFFER_SIZE
        // payload buffer and is worst-case ~290 (full-length match_id + map).
        // 1024 covers row + envelope + slack so the wrapped payload can never
        // exceed BUFFER_SIZE and truncate into invalid JSON. 6v6 never trips it;
        // on a 32-slot server the summary caps at ~17 whole rows (graceful).
        if (strlen(json) > BUFFER_SIZE - 1024) break;

        new steamid[32], name[64], name_esc[128], team_str[16];
        get_steamid(id, steamid, charsmax(steamid));
        get_user_name(id, name, charsmax(name));
        escape_json(name, name_esc, charsmax(name_esc));
        get_team_str(team, team_str, charsmax(team_str));

        static pbuf[512];
        formatex(pbuf, charsmax(pbuf),
            "%s{^"user_id^":^"%s^",^"name^":^"%s^",^"team^":^"%s^",^"kills^":%d,^"deaths^":%d,^"assists^":%d,^"damage^":%d,^"hs_kills^":%d,^"nade_kills^":%d,^"gun_kills^":%d,^"hits^":%d,^"hs_hits^":%d,^"obj_score^":%d,^"caps^":%d,^"cap_breaks^":%d,^"best_streak^":%d}",
            first ? "" : ",", steamid, name_esc, team_str,
            g_player_kills[id], g_player_deaths[id], g_player_assists[id],
            g_player_damage[id], g_player_hs_kills[id],
            g_player_nade_kills[id], g_player_gun_kills[id],
            g_player_hits[id], g_player_hs_hits[id], g_player_objscore[id],
            g_player_caps[id], g_player_cap_breaks[id], g_player_best_streak[id]);
        add(json, charsmax(json), pbuf);
        first = false;
    }

    add(json, charsmax(json), "]}");
    post_event(json);
}

// DODX forward: prone state change
public dod_client_prone(id, value) {
    if (!is_user_connected(id) || !is_user_alive(id)) return;

    // value=1 going prone, value=0 getting up
    // Also check dod_get_pronestate for deployed vs prone distinction
    new prone_state;
    if (value == 0) {
        prone_state = PRONE_STANDING;
    } else {
        new raw = dod_get_pronestate(id);
        if (raw == PS_PRONEDEPLOY || raw == PS_DEPLOY)
            prone_state = PRONE_DEPLOYED;
        else
            prone_state = PRONE_PRONE;
    }

    if (prone_state != g_player_prone[id]) {
        g_player_prone[id] = prone_state;
        do_prone_change(id, prone_state);
    }
}

// DODX forward: weapon switch — emit the live held weapon for the HUD weapon icon.
// NOTE: ignore wpnew/wpnold. DODX executes this forward as (id, current, old) — the
// header's named (wpnew, wpnold) order is wrong — so read the authoritative held
// weapon via dod_get_user_weapon(id) instead of trusting the args.
public dod_client_weaponswitch(id, wpnew, wpnold) {
    if (!is_user_connected(id) || is_user_hltv(id)) return;

    new wpnid = dod_get_user_weapon(id);
    if (wpnid <= 0) return;

    new steamid[32], weapon[32];
    get_steamid(id, steamid, charsmax(steamid));
    xmod_get_wpnlogname(wpnid, weapon, charsmax(weapon));

    new json[160];
    formatex(json, charsmax(json),
        "{^"event^":^"weapon_active^",^"user_id^":^"%s^",^"weapon^":^"%s^"}",
        steamid, weapon);
    post_event(json);
}

// Per-player live snapshot poll (4 Hz). Renamed from task_poll_prone — it still
// does the on-change prone detection (the shame timer needs the server-stamped
// prone_change), and now ALSO emits one batched player_state snapshot per tick
// carrying live held weapon / grenades / health / prone for every alive
// player. Task-driven, so it inherits the half-1 changelevel-wedge until the
// KTPAdminAudit server_exec() fix is fleet-deployed; works in half-2 regardless.
// Socket-only on the backend (player_state is NOT persisted to events.jsonl).
public task_poll_player_state() {
    static ps_json[BUFFER_SIZE];
    copy(ps_json, charsmax(ps_json), "{^"event^":^"player_state^",^"players^":[");
    new bool:first = true;

    for (new id = 1; id <= get_maxplayers(); id++) {
        if (!is_user_connected(id) || !is_user_alive(id)) continue;

        // ── Prone detection (unchanged: emits discrete prone_change on transition) ──
        new prone_raw = dod_get_pronestate(id);
        new prone_state;
        if (prone_raw == PS_NOPRONE)         prone_state = PRONE_STANDING;
        else if (prone_raw == PS_PRONE)      prone_state = PRONE_PRONE;
        else                                 prone_state = PRONE_DEPLOYED;

        if (prone_state != g_player_prone[id]) {
            g_player_prone[id] = prone_state;
            do_prone_change(id, prone_state);
        }

        // ── Snapshot fields (clip/reserve ammo intentionally omitted — HLTV
        //    already shows bullets-left; caster feedback says the HUD bar was
        //    distracting) ──
        new wpnid = dod_get_user_weapon(id);
        new weapon[32];
        if (wpnid > 0) xmod_get_wpnlogname(wpnid, weapon, charsmax(weapon));
        else           weapon[0] = '^0';

        // Allies hand + mills grenades share one pool (DODW_HANDGRENADE); Axis = stick.
        // pdata-offset read — validate on the prod dod_i386.so before fleet rollout.
        new nade_type = (g_player_team[id] == TEAM_AXIS) ? DODW_STICKGRENADE : DODW_HANDGRENADE;
        // Pass a negative through UNCLAMPED. dodx 2.7.32 returns -1 when it
        // cannot resolve the per-map ammo index, where every earlier build
        // returned 0 — indistinguishable from an empty pool, which is exactly
        // the defect reported as KTPAMXX#15. Clamping here would throw that
        // distinction away again; the overlay normalises <0 to "unknown" and
        // hides the pip rather than claiming the player has no grenades.
        // Inert until the fleet takes 2.7.32: older modules never return <0.
        new nades = dodx_get_grenade_ammo(id, nade_type);

        new prone_str[16];
        get_prone_str(prone_state, prone_str, charsmax(prone_str));

        new steamid[32];
        get_steamid(id, steamid, charsmax(steamid));

        // Defensive: stop before overflowing. The reserve is the sum of every
        // thing still to be appended after this point — keep the arithmetic here
        // honest when adding another trailing block, rather than guessing:
        //
        //     one more player entry (pbuf)                       192
        //     trailing waves block   (wbuf, worst case 82)         96
        //     trailing scoring block (sbuf, worst case 69)         96
        //     post_event envelope prefix (full match_id + map)    165
        //     slack                                                27
        //                                                        ----
        //                                                         576
        //
        // 6v6 runs ~1380 bytes, 39% of the resulting 3520 threshold; a 32-slot
        // pub truncates at ~29 whole player rows instead of ~30. Truncation is
        // always on a whole entry, so the JSON stays valid either way.
        if (strlen(ps_json) > BUFFER_SIZE - 576) break;

        static pbuf[192];
        formatex(pbuf, charsmax(pbuf),
            "%s{^"user_id^":^"%s^",^"weapon^":^"%s^",^"nades^":%d,^"health^":%d,^"prone_state^":^"%s^"}",
            first ? "" : ",", steamid, weapon, nades, get_user_health(id), prone_str);
        add(ps_json, charsmax(ps_json), pbuf);
        first = false;
    }

    add(ps_json, charsmax(ps_json), "]");

    // ── Team-level reinforcement-wave block ──────────────────────────────────
    // A side is omitted entirely when its clock is idle (nobody waiting) or
    // unreadable, so the overlay hides its pill instead of rendering a
    // fabricated countdown. `pending` is sent rather than derived frontend-side
    // from the store's dead count: it is the same set the clock itself keys on,
    // and counted ONCE here for both uses, so the pill can never disagree with
    // the timer beside it.
    new pend_allies = wave_pending(TEAM_ALLIES);
    new pend_axis   = wave_pending(TEAM_AXIS);
    new Float:wave_allies = hud_wave_time_f(TEAM_ALLIES, pend_allies);
    new Float:wave_axis   = hud_wave_time_f(TEAM_AXIS,   pend_axis);
    new bool:have_wave = (wave_allies >= 0.0 || wave_axis >= 0.0);

    if (have_wave) {
        static wbuf[128];
        new wlen = formatex(wbuf, charsmax(wbuf), ",^"waves^":{");
        if (wave_allies >= 0.0) {
            wlen += formatex(wbuf[wlen], charsmax(wbuf) - wlen,
                "^"allies^":{^"in^":%.2f,^"pending^":%d}",
                wave_allies, pend_allies);
        }
        if (wave_axis >= 0.0) {
            wlen += formatex(wbuf[wlen], charsmax(wbuf) - wlen,
                "%s^"axis^":{^"in^":%.2f,^"pending^":%d}",
                (wave_allies >= 0.0) ? "," : "", wave_axis, pend_axis);
        }
        formatex(wbuf[wlen], charsmax(wbuf) - wlen, "}");
        add(ps_json, charsmax(ps_json), wbuf);
    }

    // ── Team-level territorial scoring-tick block ────────────────────────────
    // ONE shared clock (the map has a single control-point master) plus a
    // per-team projected award — unlike waves, which are two independent
    // per-team phases. The whole block is omitted when there is no honest
    // answer, and the award PAIR is omitted independently of the clock: an
    // unvalidated map, a stale dodx with no CP default owners, or an operator
    // pulling dod_hud_score_award all leave the countdown up and the numbers
    // dark, which is the useful half of the degradation.
    // Nobody on a team means nothing is being broadcast and nothing can be
    // captured, so the scoring countdown is real but pointless. This gate is
    // NOT cosmetic: without it an idle server POSTs this block at 4 Hz forever,
    // where the pre-2.4.0 build posted nothing at all. Measured on the fleet
    // 2026-08-13 — per-server ingest went 2.07 -> 5.55 eps and every one of
    // those frames carried an empty player array. Roster-gated, not
    // alive-gated: a full team wipe still ships, which is when it matters most.
    new roster = 0;
    for (new id = 1; id <= get_maxplayers() && id <= MAX_PLAYERS; id++) {
        if (!is_user_connected(id) || is_user_hltv(id)) continue;
        if (g_player_team[id] == TEAM_ALLIES || g_player_team[id] == TEAM_AXIS) { roster = 1; break; }
    }

    // Still CALL the estimator with an empty roster — it settles open score
    // frames and rolls its anchor, and skipping that would leave stale state to
    // be interpreted against a much later gametime once players arrive. Only
    // the emission is suppressed.
    new Float:tick_in = hud_score_tick_time_f();
    if (!roster) tick_in = -1.0;

    // `every` bounds the countdown frontend-side ("in can never exceed one
    // period"). Prefer the MEASURED period; on the closed-loop path the native
    // answers the countdown directly so the estimator never locks one, and the
    // map's nominal delay stands in. Zero means neither is known — emitting it
    // would trip that guard and hide the panel exactly when the clock is most
    // trustworthy, so it is omitted instead.
    new Float:every = g_ts_period;
    if (every <= 0.0 && g_has_score_period_native) {
        new nominal = dodx_get_score_tick_period();
        // The real spacing runs slightly longer than the configured delay
        // (30.49s measured against a delay of 30 — the master only awards on
        // its own think), so the bound has to sit above it or it would reject
        // the honest value at the top of each cycle.
        if (nominal > 0) every = float(nominal) + 1.0;
    }

    // A period far longer than a round's tactical rhythm is not worth showing;
    // see TICK_MAX_USEFUL_PERIOD. Gate on the period we actually know about —
    // an unknown period is NOT assumed to be long, since the open-loop
    // estimator only ever locks periods inside [TICK_PERIOD_MIN, MAX] anyway.
    new bool:have_tick = (tick_in >= 0.0)
        && (every <= 0.0 || every <= TICK_MAX_USEFUL_PERIOD);

    if (have_tick) {
        new aw_a = hud_score_award(TEAM_ALLIES);
        new aw_x = hud_score_award(TEAM_AXIS);
        static sbuf[128];
        new slen = formatex(sbuf, charsmax(sbuf), ",^"scoring^":{^"in^":%.2f", tick_in);
        if (every > 0.0) {
            slen += formatex(sbuf[slen], charsmax(sbuf) - slen,
                ",^"every^":%.2f", every);
        }
        if (aw_a >= 0 && aw_x >= 0) {
            slen += formatex(sbuf[slen], charsmax(sbuf) - slen,
                ",^"allies^":%d,^"axis^":%d", aw_a, aw_x);
        }
        formatex(sbuf[slen], charsmax(sbuf) - slen, "}");
        add(ps_json, charsmax(ps_json), sbuf);
    }

    add(ps_json, charsmax(ps_json), "}");

    // Skip the POST only when there is genuinely nothing to say. `first` alone
    // is no longer the test: a full team wipe leaves the player array empty and
    // is precisely when the wave clock matters most.
    if ((!first || have_wave || have_tick) && g_cvar_url[0]) post_event(ps_json);
}

public ev_team_score() {
    // Read from gamerules (dodx_get_team_score), not from DODX message-tracked
    // globals (dod_get_team_score). In extension mode the DODX Client_TeamScore
    // handler doesn't see broadcasts, so the legacy native returns stale 0s —
    // which silently dropped tick-scoring increments and per-cap updates.
    new allies = dodx_get_team_score(TEAM_ALLIES);
    new axis   = dodx_get_team_score(TEAM_AXIS);

    // Feed the territorial-tick estimator. This is the ONLY observation point
    // for it: the master's award clock is invisible everywhere else, and its
    // awards surface purely as TeamScore broadcasts.
    score_tick_observe(allies, axis);

    new json[128];
    formatex(json, charsmax(json),
        "{^"event^":^"team_score^",^"allies_score^":%d,^"axis_score^":%d}",
        allies, axis);
    post_event(json);
}

public task_time_sync() {
    new json[128];
    formatex(json, charsmax(json),
        "{^"event^":^"time_sync^",^"timeleft^":%.2f}", hud_timeleft_f());
    post_event(json);
}

// ─── Flag Zone Polling ───────────────────────────────────────────────────────
// Reads game-authoritative CAreaCapture state via dodx_ktp CA_VALUE natives.
// No AABB/distance math — the engine's trigger-touch logic is the source of truth.
// Captor names are attributed post-cap via dod_score_event (see below).
// Emits:
//   flag_zone_players   per-tick allies/axis counts (no names available here)
//   flag_cap_started    when m_bCapturing goes 0 -> non-zero
//   flag_cap_stopped    when m_bCapturing returns to 0 without a capture
//   flag_cap_progress   each tick while capping (derived from m_fTimeRemaining)
//   flag_cap_contested  when opposing team has >= 1 player in the zone mid-cap

public task_poll_zones() {
    if (g_flag_count <= 0 || !g_cvar_url[0]) return;

    static zones_json[BUFFER_SIZE];
    copy(zones_json, charsmax(zones_json), "{^"event^":^"flag_zone_players^",^"zones^":[");
    new bool:first_zone = true;

    // `f` is the DLL cp_index — the space our g_flag_* state and every emitted
    // flag_id live in, so zone-derived events line up with the cap events that
    // dod_control_point_captured delivers. `dx` is the dodx slot to read from.
    for (new f = 0; f < g_flag_count && f < MAX_FLAGS; f++) {
        new dx = g_cp_dodx_of_dll[f];
        new ac = dodx_area_get_data(dx, CA_num_allies);
        new xc = dodx_area_get_data(dx, CA_num_axis);
        if (ac < 0) ac = 0;
        if (xc < 0) xc = 0;

        // Required cappers per team (static per flag, set in cap_area entity keyvalues).
        new an = dodx_area_get_data(dx, CA_allies_numcap);
        new xn = dodx_area_get_data(dx, CA_axis_numcap);
        if (an < 1) an = 1;
        if (xn < 1) xn = 1;

        // Zone counts — emit every tick so UI can clear when zones empty.
        static zbuf[160];
        formatex(zbuf, charsmax(zbuf),
            "%s{^"flag_id^":%d,^"allies_count^":%d,^"axis_count^":%d,^"allies_numcap^":%d,^"axis_numcap^":%d}",
            first_zone ? "" : ",", f, ac, xc, an, xn);
        add(zones_json, charsmax(zones_json), zbuf);
        first_zone = false;

        // ── Cap state transitions (game-authoritative) ──
        new is_capping = dodx_area_get_data(dx, CA_is_capturing);
        new new_capper = is_capping ? dodx_area_get_data(dx, CA_capturing_team) : 0;

        new prev_capper = g_flag_capping_team[f];
        new bool:was_contested = g_flag_contested[f];

        // Contested: a team is actively capping AND the opposing team is also in the zone.
        new bool:now_contested = false;
        if (new_capper == TEAM_ALLIES && xc > 0) now_contested = true;
        if (new_capper == TEAM_AXIS   && ac > 0) now_contested = true;

        if (prev_capper == 0 && new_capper != 0) {
            g_flag_capping_team[f]   = new_capper;
            g_flag_contested[f]      = now_contested;
            g_flag_last_progress[f]  = -1;
            emit_cap_started(f, new_capper);
        }
        else if (prev_capper != 0 && new_capper == 0) {
            g_flag_capping_team[f]  = 0;
            g_flag_contested[f]     = false;
            g_flag_last_progress[f] = -1;
            emit_cap_stopped(f, prev_capper);
        }
        else if (prev_capper != 0 && new_capper != 0 && prev_capper != new_capper) {
            g_flag_capping_team[f]  = new_capper;
            g_flag_contested[f]     = now_contested;
            g_flag_last_progress[f] = -1;
            emit_cap_stopped(f, prev_capper);
            emit_cap_started(f, new_capper);
        }

        // Contested state toggles while capping
        if (g_flag_capping_team[f] != 0 && now_contested && !was_contested) {
            g_flag_contested[f] = true;
            new contesting_team = (g_flag_capping_team[f] == TEAM_ALLIES) ? TEAM_AXIS : TEAM_ALLIES;
            new contester_count = (contesting_team == TEAM_ALLIES) ? ac : xc;
            emit_cap_contested(f, contesting_team, contester_count);
        } else if (g_flag_capping_team[f] != 0 && !now_contested && was_contested) {
            g_flag_contested[f] = false;
        }

        // Progress tick (derived from m_fTimeRemaining / m_nCapTime).
        if (g_flag_capping_team[f] != 0) {
            new Float:remaining = Float:dodx_area_get_data(dx, CA_time_remaining);
            new cap_time        = dodx_area_get_data(dx, CA_timetocap);
            if (cap_time > 0 && remaining >= 0.0) {
                new Float:pct = 100.0 - (remaining * 100.0 / float(cap_time));
                new progress = floatround(pct);
                if (progress < 0)   progress = 0;
                if (progress > 100) progress = 100;
                if (progress != g_flag_last_progress[f]) {
                    g_flag_last_progress[f] = progress;
                    emit_cap_progress(f, g_flag_capping_team[f], progress);
                }
            }
        }

        // Credit pending cap-break candidates (queued in client_death) as the
        // broken team's in-zone count drops below the rolling baseline. The
        // engine applies the death decrement 0.2–2.5s late (prod-measured), so
        // candidates stay live for BREAK_WINDOW_POLLS polls — deliberately
        // surviving the flag_cap_stopped transition the break itself causes.
        // Count rises re-anchor the baseline (a joiner who later leaves is not
        // a break). Round restarts zero the counts, which would fake a drop —
        // dod_control_point_captured's restart guard paths clear the queue.
        if (g_break_q_count[f] > 0) {
            new bt = g_break_team[f];
            new now_count = (bt == TEAM_ALLIES) ? ac : xc;
            if (now_count > g_break_baseline[f]) {
                g_break_baseline[f] = now_count;
            } else if (now_count < g_break_baseline[f]) {
                new drops = g_break_baseline[f] - now_count;
                while (drops > 0 && g_break_q_count[f] > 0) {
                    new breaker = g_break_q_killer[f][0];
                    if (is_user_connected(breaker)) {
                        g_player_cap_breaks[breaker]++;
                        emit_cap_break(f, breaker, bt);
                        emit_player_score(breaker);
                    }
                    break_queue_shift(f);
                    drops--;
                }
                g_break_baseline[f] = now_count;
            }
            // Age out candidates whose window elapsed (their victim never
            // produced a count drop — off-point kill).
            for (new qi = 0; qi < g_break_q_count[f]; qi++) g_break_q_ttl[f][qi]--;
            while (g_break_q_count[f] > 0 && g_break_q_ttl[f][0] <= 0) {
                break_queue_shift(f);
            }
        }

        g_flag_prev_allies_count[f] = ac;
        g_flag_prev_axis_count[f]   = xc;
    }
    add(zones_json, charsmax(zones_json), "]}");
    post_event(zones_json);
}

stock emit_cap_started(cp_index, team) {
    new team_str[16];
    get_team_str(team, team_str, charsmax(team_str));
    // captor_ids is intentionally empty — per-player zone membership isn't
    // available in extension mode. Names surface via dod_score_event on success.
    new json[384];
    formatex(json, charsmax(json),
        "{^"event^":^"flag_cap_started^",^"flag_id^":%d,^"flag_name^":^"%s^",^"capping_team^":^"%s^",^"captor_ids^":[]}",
        cp_index, g_flag_name_cache[cp_index], team_str);
    post_event(json);
}

stock emit_cap_stopped(cp_index, team) {
    new team_str[16];
    get_team_str(team, team_str, charsmax(team_str));
    new json[256];
    formatex(json, charsmax(json),
        "{^"event^":^"flag_cap_stopped^",^"flag_id^":%d,^"flag_name^":^"%s^",^"capping_team^":^"%s^"}",
        cp_index, g_flag_name_cache[cp_index], team_str);
    post_event(json);
}

stock emit_cap_contested(cp_index, contesting_team, count) {
    new team_str[16];
    get_team_str(contesting_team, team_str, charsmax(team_str));
    new json[320];
    formatex(json, charsmax(json),
        "{^"event^":^"flag_cap_contested^",^"flag_id^":%d,^"flag_name^":^"%s^",^"contesting_team^":^"%s^",^"contester_count^":%d,^"contester_ids^":[]}",
        cp_index, g_flag_name_cache[cp_index], team_str, count);
    post_event(json);
}

stock emit_cap_progress(cp_index, team, progress) {
    new team_str[16];
    get_team_str(team, team_str, charsmax(team_str));
    new json[256];
    formatex(json, charsmax(json),
        "{^"event^":^"flag_cap_progress^",^"flag_id^":%d,^"capping_team^":^"%s^",^"progress^":%d}",
        cp_index, team_str, progress);
    post_event(json);
}

stock break_queue_clear(f) {
    g_break_q_count[f]  = 0;
    g_break_team[f]     = 0;
    g_break_baseline[f] = 0;
}

// Pop the oldest candidate (credited or expired); FIFO order is arm order.
stock break_queue_shift(f) {
    for (new i = 1; i < g_break_q_count[f]; i++) {
        g_break_q_killer[f][i - 1] = g_break_q_killer[f][i];
        g_break_q_ttl[f][i - 1]    = g_break_q_ttl[f][i];
    }
    g_break_q_count[f]--;
    if (g_break_q_count[f] == 0) g_break_team[f] = 0;
}

// A cap was broken by a kill: an enemy killed a capper on the point, removing
// them from the capture zone (confirmed by a zone-count drop within the
// confirm window — the engine applies the death decrement 0.2–2.5s late).
// breaker_id = the killer (credited the cap_break stat); broke_team = the
// capping team that lost the capper.
stock emit_cap_break(cp_index, breaker, broke_team) {
    new steamid[32], team_str[16];
    get_steamid(breaker, steamid, charsmax(steamid));
    get_team_str(broke_team, team_str, charsmax(team_str));
    new json[256];
    formatex(json, charsmax(json),
        "{^"event^":^"cap_break^",^"flag_id^":%d,^"flag_name^":^"%s^",^"reason^":^"kill^",^"breaker_id^":^"%s^",^"broke_team^":^"%s^"}",
        cp_index, g_flag_name_cache[cp_index], steamid, team_str);
    post_event(json);
}

// ─── Chat ────────────────────────────────────────────────────────────────────

stock do_say(id, team_only) {
    new steamid[32], msg[128], msg_esc[256];
    get_steamid(id, steamid, charsmax(steamid));
    read_args(msg, charsmax(msg));
    remove_quotes(msg);
    escape_json(msg, msg_esc, charsmax(msg_esc));

    new json[384];
    formatex(json, charsmax(json),
        "{^"event^":^"user_say^",^"user_id^":^"%s^",^"team_only^":%s,^"message^":^"%s^"}",
        steamid, team_only ? "true" : "false", msg_esc);
    post_event(json);
    return PLUGIN_CONTINUE;
}

public ev_say(id)      { return do_say(id, 0); }
public ev_say_team(id) { return do_say(id, 1); }

// ─── Flag / Objective Events (DODX natives) ─────────────────────────────────

// DODX forward: called after map control point data is initialized
public controlpoints_init() {
    server_print("[HUD] controlpoints_init fired");
    do_flags_init("map_load");
}

// Populate g_cp_dodx_of_dll for the current map (identity unless the map is a
// known offender — see the g_cp_dodx_of_dll declaration for the index spaces).
//
// Explicit per-map permutations, NOT a generic geometric sort: such a sort would
// have to run only where dodx's own BSP reorder DIDN'T, and a plugin can't tell
// whether it ran. Guessing wrong on a currently-correct map would be a
// regression, so the allowlist stays narrow and evidence-backed.
//
// To derive an entry for a newly-affected map: watch for
// `[DODX] BSP parse returned 0 CPs` (or a `BSP CP count != entity scan count`
// mismatch) in the server log, then
//   1. `scripts/cp-entity-dump.py <map.bsp>` — confirms the defect from the BSP
//      itself and prints a candidate ordering, but read its ambiguity warnings:
//      position alone cannot separate two flags at similar depth offset sideways
//      (it backtests 1 of 4 on maps with a side objective), so it is a starting
//      point, not an answer.
//   2. play one match, then `scripts/cp-index-space.py <matches_dir> <map>` — the
//      flag_id whose captures carry a +2 team-score delta is the map's
//      point_team_points=2 CP, which pins the permutation.
// Background: docs/dodx-cp-index-space-findings.md. The map-side fix (have the
// mapper set point_index) is specified in docs/mapper-point-index-spec.md.
//
// dod_northbound also skips the reorder (4 of 5 CPs carry point_index, so the
// counts mismatch) but its spawn order already equals the DLL's, so identity is
// correct there — deliberately not listed.
stock init_cp_index_remap() {
    for (new i = 0; i < MAX_FLAGS; i++) g_cp_dodx_of_dll[i] = i;

    new mapname[64];
    get_mapname(mapname, charsmax(mapname));

    // dod_saints2_b3e / _b2 — ships point_index=-1 on every CP (the key is
    // present but unusable, so dodx's >= 0 filter drops it). dodx array order is
    // [Bridge, Allied 1st, Allied 2nd, Axis 2nd, Axis 1st]; the DLL orders them
    // allies->axis, which puts the bridge 3rd. VERIFIED on b3e across 65 prod
    // matches; b2 shares b3e's CP names, spawn order and relative geometry.
    if (equal(mapname, "dod_saints2_b3e") || equal(mapname, "dod_saints2_b2")) {
        g_cp_dodx_of_dll[0] = 1;   // Allied 1st
        g_cp_dodx_of_dll[1] = 2;   // Allied 2nd
        g_cp_dodx_of_dll[2] = 0;   // The Bridge  (point_team_points=2)
        g_cp_dodx_of_dll[3] = 3;   // Axis 2nd
        g_cp_dodx_of_dll[4] = 4;   // Axis 1st
        server_print("[HUD] CP index remap active for %s", mapname);
        return;
    }

    // dod_donner — stock map, ships point_index=-1 on every CP. dodx array order
    // is [AxisHQ, AxisStreet, AlliedStreet, AlliedHQ, MainStreet]; allies->axis
    // geometry gives [AlliedHQ, AlliedStreet, MainStreet, AxisStreet, AxisHQ].
    //
    // Derived from CP origins and then corroborated against the operator's own
    // map knowledge (2026-07-30) — AXISHQ is axis-first, AXISSTREET axis-second,
    // ALLIEDSTREET allied-second, ALLIEDHQ allied-first, MAINSTREET the middle
    // double-cap — which matches this permutation exactly. Structurally identical
    // to saints2 too: 5 CPs, a single dod_capture_area on the neutral
    // point_team_points=2 centre flag (numcap 2, 5s), landing on DLL index 2.
    //
    // Not yet confirmed from event data (donner has 0 recorded HUD matches). Run
    // the procedure above after its first match to close that out.
    if (equal(mapname, "dod_donner")) {
        g_cp_dodx_of_dll[0] = 3;   // AlliedHQ
        g_cp_dodx_of_dll[1] = 2;   // AlliedStreet
        g_cp_dodx_of_dll[2] = 4;   // MainStreet  (point_team_points=2)
        g_cp_dodx_of_dll[3] = 1;   // AxisStreet
        g_cp_dodx_of_dll[4] = 0;   // AxisHQ
        server_print("[HUD] CP index remap active for %s (geometry-derived)", mapname);
        return;
    }
}

// `reason` tells the frontend how much to trust this snapshot. "map_load",
// "match_start" and "reset" are authoritative full-state broadcasts and are adopted
// verbatim, neutrals included; "tick" is the 30s heartbeat, which the overlay is
// allowed to treat conservatively. Without the distinction the overlay cannot tell
// a genuine reset-to-neutral from a stale heartbeat, and had to refuse both.
stock do_flags_init(const reason[] = "tick") {
    // Seed the index remap BEFORE the early return, so the table is never left
    // all-zeros (which would alias every DLL index onto dodx slot 0). Cheap — a
    // few string compares — and idempotent, so running it on every re-init is fine.
    init_cp_index_remap();

    g_flag_count = dodx_objectives_get_num();
    if (g_flag_count <= 0) return;

    static json[BUFFER_SIZE];
    static tmp[128];
    formatex(json, charsmax(json),
        "{^"event^":^"flags_init^",^"reason^":^"%s^",^"flags^":[", reason);

    // `i` is the DLL cp_index (the space every emitted flag_id and all of our
    // g_flag_* state lives in); `dx` is the dodx array slot to read it from.
    for (new i = 0; i < g_flag_count && i < MAX_FLAGS; i++) {
        new dx = g_cp_dodx_of_dll[i];
        g_flag_default_owner[i] = dodx_objective_get_data(dx, CP_default_owner);
        new owner = dodx_objective_get_data(dx, CP_owner);
        g_flag_owner[i] = owner;

        g_flag_capping_team[i]          = 0;
        g_flag_contested[i]             = false;
        g_flag_last_progress[i]         = -1;
        g_flag_prev_allies_count[i]     = 0;
        g_flag_prev_axis_count[i]       = 0;
        break_queue_clear(i);
        // Don't wipe the captor batch / last-capper while a deferred cap emission
        // is in flight (e.g. the 30s task_emit_flags or a round-start re-init
        // landing within DEFER_DELAY of a cap) — deferred_emit_cap still needs the
        // batch, and dod_score_event credits obj_score against g_flag_last_capped_by
        // in that same ~0.25s window. plugin_cfg does the unconditional map-load wipe.
        if (!g_flag_emit_pending[i]) {
            g_flag_pending_captor_count[i]  = 0;
            g_flag_last_capped_by[i]        = 0;
        }

        new owner_str[16];
        if      (owner == TEAM_ALLIES) copy(owner_str, charsmax(owner_str), "allies");
        else if (owner == TEAM_AXIS)   copy(owner_str, charsmax(owner_str), "axis");
        else                           copy(owner_str, charsmax(owner_str), "neutral");

        new flag_name[64];
        dodx_objective_get_data(dx, CP_name, flag_name, charsmax(flag_name));
        if (flag_name[0] == '^0') formatex(flag_name, charsmax(flag_name), "flag_%d", i);
        copy(g_flag_name_cache[i], charsmax(g_flag_name_cache[]), flag_name);

        formatex(tmp, charsmax(tmp),
            "%s{^"flag_id^":%d,^"flag_name^":^"%s^",^"owner^":^"%s^"}",
            i > 0 ? "," : "", i, flag_name, owner_str);
        add(json, charsmax(json), tmp);
    }
    add(json, charsmax(json), "]}");
    post_event(json);
}

// DODX forward: dod_score_event(id, score_delta, total_score, cp_index)
// Fires (deferred ~0.25s, from dodx PreThink) once per player credited with a CP
// cap, after dod_control_point_captured has already set the new owner. This is
// where obj_score/caps are credited; the per-cp batch only feeds captor identity.
public dod_score_event(id, score_delta, total_score, cp_index) {
    if (cp_index < 0 || cp_index >= MAX_FLAGS) return;
    if (!is_user_connected(id)) return;

    // Ignore zero/negative deltas — only actual point gains count as a cap credit.
    // DODX's Client_ObjScore can fire with savedScore drift after scoreboard resets,
    // producing spurious events for non-capping players on the opposing team.
    if (score_delta <= 0) return;

    new n = g_flag_pending_captor_count[cp_index];
    if (n >= MAX_CAPTORS) return;

    // Skip duplicates (defensive — each player should fire once per cap)
    for (new i = 0; i < n; i++) {
        if (g_flag_pending_captor_ids[cp_index][i] == id) return;
    }

    g_flag_pending_captor_ids[cp_index][n]   = id;
    g_flag_pending_captor_score[cp_index][n] = score_delta;
    g_flag_pending_captor_count[cp_index]    = n + 1;

    // Credit obj_score + caps HERE — not in dod_control_point_captured. In DoD the
    // engine sends the CP-owner (SetObj) message — which fires
    // dod_control_point_captured SYNCHRONOUSLY — BEFORE it dispatches this score
    // event: dodx arms sendScore = time + 0.25 in Client_ObjScore and fires
    // dod_score_event ~0.25s later from PreThink (KTPAMXX usermsg.cpp:122-129,
    // moduleconfig.cpp:1056-1074). So by now the capping team is already known.
    // Crediting at capture time instead read an empty batch (the batch is filled
    // right here, AFTER the capture handler ran) — that was the all-zeros bug.
    // Filter against g_flag_last_capped_by (the last REAL capper for this CP), NOT
    // the live g_flag_owner: the post-capout round-restart flips g_flag_owner to
    // neutral inside this 0.25s window and would reject the round-winning cap.
    // The team gate also drops opposing-team savedScore-drift score events.
    if (get_user_team(id) == g_flag_last_capped_by[cp_index]) {
        g_player_objscore[id] += score_delta;
        g_player_caps[id]++;
        emit_player_score(id);
    }
}

// Open (or extend) the round-restart cascade window and schedule the single
// authoritative flags_init that closes it. Idempotent: every flag in the burst
// calls this, and the re-armed one-shot collapses them into one snapshot.
//
// The delay must outlast the whole cascade AND the DEFER_DELAY emissions it may
// need to cancel, so the snapshot is the last word on ownership.
stock arm_cp_reset_window() {
    new Float:now = get_gametime();
    // The one-shot clears the latch when it fires, which is CP_RESET_WINDOW +
    // DEFER_DELAY after the last arm. A latch still set well past that means the
    // task was lost, so don't let it wedge the snapshot off for the rest of the
    // map — re-arm. Self-healing, and rare enough not to have the tight-loop shape
    // the guard below exists to avoid.
    new bool:already_armed = g_cp_reset_task_pending
        && now < g_cp_reset_until + DEFER_DELAY + 1.0;
    g_cp_reset_until = now + CP_RESET_WINDOW;
    if (already_armed) return;
    remove_task(TASK_ID_RESET_SNAPSHOT);

    // Deliberately ONE set_task per cascade — extend the window in place rather
    // than remove_task + set_task per flag. A cascade dispatches every CP in a
    // single frame, and re-arming a task that fast from inside the forward is the
    // shape that trips KTPAMXX's shared-SP-forward free (the same hazard behind
    // "a tight loop of cap dispatches drops the last one",
    // KTPInfrastructure/tests/integration/test_hud_observer_flag_emission.py).
    // Losing the LAST re-arm means losing the snapshot entirely — observed on the
    // local repro before this was pinned down.
    g_cp_reset_task_pending = true;
    set_task(CP_RESET_WINDOW + DEFER_DELAY, "task_reset_snapshot", TASK_ID_RESET_SNAPSHOT);
}

public task_reset_snapshot() {
    // A staggered cascade can push the window past this firing. Wait it out so the
    // snapshot is always the LAST word on ownership, never a mid-cascade read.
    new Float:remaining = g_cp_reset_until - get_gametime();
    if (remaining > 0.0) {
        set_task(remaining + DEFER_DELAY, "task_reset_snapshot", TASK_ID_RESET_SNAPSHOT);
        return;
    }
    g_cp_reset_task_pending = false;
    do_flags_init("reset");
}

// DODX forward: control point captured
public dod_control_point_captured(cp_index, new_owner, old_owner) {
    if (cp_index < 0 || cp_index >= MAX_FLAGS) return;

    // Suppress two classes of spurious events observed in prod (1.3-5828-NY1):
    //   1. Same-owner duplicates — DODX's usermsg.cpp:639 owner-change guard
    //      doesn't always hold; we saw same-flag/same-owner events 540ms apart.
    //   2. Round-restart resets — on objective end, the engine flips every flag
    //      back to its initial state. DODX fires this forward for each, with
    //      new_owner=TEAM_SPECTATOR. Five simultaneous "neutral" captures per
    //      restart polluted the HUD feed with phantom events. Real caps always
    //      transition straight from one team to the other; an in-game flag
    //      never goes neutral mid-round.
    // Clear any pending captor batch on these non-credit paths so a stale batch
    // can't later mis-credit caps/obj_score when the flag is genuinely captured.
    // (Before caps were credited at capture time this was display-only; now it
    // matters.) A real cap always processed/credited before these fire.
    // A genuine cap may already have a deferred emission pending (its captor
    // batch is mid-fill). Don't wipe the batch on these guard paths if so —
    // deferred_emit_cap still needs it. Otherwise clear it (display-only stale
    // batch) as before.
    if (g_flag_owner[cp_index] == new_owner) {
        if (!g_flag_emit_pending[cp_index]) g_flag_pending_captor_count[cp_index] = 0;
        break_queue_clear(cp_index);
        return;
    }
    if (new_owner != TEAM_ALLIES && new_owner != TEAM_AXIS) {
        // Unambiguous reset marker: a live flag never goes neutral mid-round, so
        // this can only be the engine restoring defaults. Open the cascade window
        // for its siblings (the whole burst lands in one frame) and schedule the
        // authoritative re-broadcast — this path emits no flag_captured, so the
        // snapshot is the ONLY way the frontend ever learns the flag went neutral.
        // That was the "flags don't reset after a capout" bug.
        arm_cp_reset_window();

        // Same marker for the scoring-tick estimator: a restart cascade rebases
        // the master's clock, and the score noise it produces is not a tick.
        // Marked on the CASCADE, not on the +40 capout delta — a .restarthalf or
        // sv_restartround produces this cascade with no bonus at all.
        g_ts_last_reset_gt = get_gametime();

        g_flag_owner[cp_index] = new_owner;
        if (!g_flag_emit_pending[cp_index]) g_flag_pending_captor_count[cp_index] = 0;
        // Round-restart neutral cascade lands here: it zeroes every zone count,
        // which the windowed break accounting would misread as kill drops.
        break_queue_clear(cp_index);
        return;
    }

    // Mirror image on maps whose flags are default-OWNED (dod_donner, dod_kalt,
    // dod_flash, dod_saints2_*): the same cascade restores those to allies/axis,
    // which on its own is indistinguishable from a capture. Inside an already-open
    // window a transition landing exactly on the flag's default owner is the
    // cascade — credit nothing, emit nothing, let the scheduled snapshot carry it.
    //
    // The window may NOT be open yet — the engine can dispatch a team reset before
    // its neutral sibling, and a cascade that resets only home flags has no neutral
    // sibling at all. Both are handled at emission time instead; see
    // deferred_emit_cap.
    //
    // Requires dodx to know the defaults; on an older module g_flag_default_owner
    // is 0 everywhere, so neither path can fire and behaviour is unchanged.
    if (g_cp_reset_until > get_gametime()
        && g_flag_default_owner[cp_index] == new_owner) {
        g_ts_last_reset_gt = get_gametime();
        g_flag_owner[cp_index] = new_owner;
        if (!g_flag_emit_pending[cp_index]) g_flag_pending_captor_count[cp_index] = 0;
        break_queue_clear(cp_index);
        return;
    }

    // cp_index is already a DLL index, so read the name from the DLL-indexed
    // cache do_flags_init built — NOT a fresh dodx_objective_get_data(cp_index),
    // which would index dodx's array with a DLL index and mislabel the capture on
    // any map where the two spaces diverge (see g_cp_dodx_of_dll).
    new flag_name[64];
    copy(flag_name, charsmax(flag_name), g_flag_name_cache[cp_index]);
    if (flag_name[0] == '^0') formatex(flag_name, charsmax(flag_name), "flag_%d", cp_index);

    // Record the capping team for the DEFERRED credit. dod_score_event fires
    // ~0.25s after this (dodx PreThink deferral) and credits obj_score/caps
    // against g_flag_last_capped_by — kept separate from g_flag_owner, which the
    // round-restart neutral cascade can flip before that score event lands.
    g_flag_last_capped_by[cp_index]       = new_owner;

    g_flag_owner[cp_index]                = new_owner;
    g_flag_capping_team[cp_index]         = 0;
    g_flag_contested[cp_index]            = false;
    g_flag_last_progress[cp_index]        = -1;

    // A genuine capture awards team points of its own, at an arbitrary instant.
    // Mark it so a TeamScore frame landing within TICK_CAP_PROXIMITY is never
    // used to seed the tick phase, and never feeds the award model.
    g_ts_last_cap_gt = get_gametime();
    // A completed cap is NOT a break — drop any pending break candidates so the
    // post-cap zone-count drop (cappers leaving) can't be mis-credited as one.
    break_queue_clear(cp_index);

    // Capout = all flags now owned by new_owner. Round end on cap maps, and the
    // only reliable round-end trigger in prod (the Round_End logevent never fires
    // in DoD). Computed HERE (g_flag_owner is current) but emitted from the
    // deferred task so the board carries the winning flag's captor names + the
    // final cap counts (dod_score_event credits them in the ~0.25s window).
    new bool:is_capout = false;
    if (g_flag_count > 0) {
        is_capout = true;
        for (new f = 0; f < g_flag_count && f < MAX_FLAGS; f++) {
            if (g_flag_owner[f] != new_owner) { is_capout = false; break; }
        }
    }

    // Defer flag_captured + the capout board until dod_score_event has filled the
    // captor batch. Emitting synchronously here read an EMPTY batch (dodx hasn't
    // dispatched the score events yet) — the long-standing empty captor_ids /
    // capout_by bug. The per-CP one-shot reads the now-filled batch; it consumes
    // + clears the batch when it fires.
    g_flag_emit_owner[cp_index]   = new_owner;
    copy(g_flag_emit_name[cp_index], charsmax(g_flag_emit_name[]), flag_name);
    g_flag_emit_capout[cp_index]  = is_capout;
    g_flag_emit_pending[cp_index] = 1;
    g_flag_emit_armed_at[cp_index] = get_gametime();
    remove_task(TASK_ID_DEFER_BASE + cp_index);
    set_task(DEFER_DELAY, "deferred_emit_cap", TASK_ID_DEFER_BASE + cp_index);
}

// Per-CP deferred captor/capout emission. Armed by dod_control_point_captured,
// fired ~DEFER_DELAY later — after dod_score_event has populated the captor
// batch — so flag_captured carries captor_ids and the capout board carries
// capout_by (the final flag's captor names). Fixes the empty-attribution bug:
// dodx dispatches dod_score_event ~0.25s AFTER dod_control_point_captured, so a
// synchronous emit always saw an empty batch.
public deferred_emit_cap(task_id) {
    new cp_index = task_id - TASK_ID_DEFER_BASE;
    if (cp_index < 0 || cp_index >= MAX_FLAGS) return;
    if (!g_flag_emit_pending[cp_index]) return;
    g_flag_emit_pending[cp_index] = 0;

    // A reset cascade detected AFTER this was armed means the cap we were about to
    // announce was really the engine restoring a default — the neutral sibling that
    // proves it can be dispatched a frame later than this flag's own event, i.e.
    // inside DEFER_DELAY. Drop it rather than feed a phantom capture to the feed.
    //
    // Never drop a capout emission: that is the round-winning cap, and the restart
    // it triggers necessarily lands within this same window. A cascade cannot
    // itself produce a capout — that would need every flag on the map defaulting to
    // one team, which no DoD map does.
    if (!g_flag_emit_capout[cp_index]
        && g_cp_reset_until > g_flag_emit_armed_at[cp_index]) {
        g_flag_pending_captor_count[cp_index] = 0;
        return;
    }

    // Weaker evidence, weaker action. A cascade only fires for CPs that actually
    // changed, so a round in which just one home flag was taken resets exactly one
    // CP — a lone team-owner transition with no neutral sibling to open the window
    // above. It is recognisable (it lands exactly on the flag's default owner and
    // dod_score_event credited nobody), but NOT reliably: a genuine re-capture of a
    // home flag lands on the default too, and would be suppressed on the one
    // occasion its score event went missing. Losing a capture the casters just
    // watched is worse than one phantom line at a round boundary, so this only
    // SCHEDULES the authoritative snapshot — the flag bar ends up correct either
    // way, which is the actual bug — and still emits.
    if (g_flag_default_owner[cp_index] == g_flag_emit_owner[cp_index]
        && g_flag_pending_captor_count[cp_index] == 0) {
        arm_cp_reset_window();
    }

    new new_owner = g_flag_emit_owner[cp_index];
    new owner_str[16];
    if      (new_owner == TEAM_ALLIES) copy(owner_str, charsmax(owner_str), "allies");
    else if (new_owner == TEAM_AXIS)   copy(owner_str, charsmax(owner_str), "axis");
    else                               copy(owner_str, charsmax(owner_str), "neutral");

    new captor_json[256];
    build_pending_captor_list(cp_index, new_owner, captor_json, charsmax(captor_json));

    new json[512];
    formatex(json, charsmax(json),
        "{^"event^":^"flag_captured^",^"flag_id^":%d,^"flag_name^":^"%s^",^"new_owner^":^"%s^",^"captor_ids^":[%s]}",
        cp_index, g_flag_emit_name[cp_index], owner_str, captor_json);
    post_event(json);

    if (g_flag_emit_capout[cp_index]) {
        // Names of the final flag's captors so the board titles
        // "ALLIES CAPOUT BY <names>".
        new capout_by[256];
        build_captor_names(cp_index, new_owner, capout_by, charsmax(capout_by));
        emit_stats_summary(SUMMARY_ROUND_END, owner_str, capout_by);
    }

    g_flag_pending_captor_count[cp_index] = 0;
#if defined HUD_REPRO_TEST
    g_flag_test_count[cp_index] = 0;
#endif
}

stock build_pending_captor_list(cp_index, owning_team, out[], len) {
    out[0] = '^0';
    new n = g_flag_pending_captor_count[cp_index];
    new tmp[48];
    new written = 0;
    for (new i = 0; i < n; i++) {
        new id = g_flag_pending_captor_ids[cp_index][i];
        if (!is_user_connected(id)) continue;
        // Defensive: only credit players on the team that actually owns the CP now.
        // DODX score events for drifted savedScore can bleed across teams.
        if (get_user_team(id) != owning_team) continue;
        new steamid[32];
        get_steamid(id, steamid, charsmax(steamid));
        formatex(tmp, charsmax(tmp), "%s^"%s^"", written > 0 ? "," : "", steamid);
        add(out, len, tmp);
        written++;
    }
#if defined HUD_REPRO_TEST
    for (new t = 0; t < g_flag_test_count[cp_index] && t < MAX_CAPTORS; t++) {
        formatex(tmp, charsmax(tmp), "%s^"%s^"", written > 0 ? "," : "", g_flag_test_sid[cp_index][t]);
        add(out, len, tmp);
        written++;
    }
#endif
}

// Comma-joined, JSON-escaped display names of a flag's pending captors — for
// the capout board title. Same team filter as build_pending_captor_list.
stock build_captor_names(cp_index, owning_team, out[], len) {
    out[0] = '^0';
    new n = g_flag_pending_captor_count[cp_index];
    new written = 0;
    for (new i = 0; i < n; i++) {
        new id = g_flag_pending_captor_ids[cp_index][i];
        if (!is_user_connected(id)) continue;
        if (get_user_team(id) != owning_team) continue;
        // Whole entries only — a name cut mid-escape-sequence would leave a
        // dangling ^" / backslash and corrupt the summary JSON. Reserve room
        // for one full escaped name (128) + ", " separator.
        if (strlen(out) > len - 132) break;
        new name[64], name_esc[128], tmp[160];
        get_user_name(id, name, charsmax(name));
        escape_json(name, name_esc, charsmax(name_esc));
        formatex(tmp, charsmax(tmp), "%s%s", written > 0 ? ", " : "", name_esc);
        add(out, len, tmp);
        written++;
    }
#if defined HUD_REPRO_TEST
    for (new t = 0; t < g_flag_test_count[cp_index] && t < MAX_CAPTORS; t++) {
        if (strlen(out) > len - 132) break;
        new tname_esc[128], ttmp[160];
        escape_json(g_flag_test_name[cp_index][t], tname_esc, charsmax(tname_esc));
        formatex(ttmp, charsmax(ttmp), "%s%s", written > 0 ? ", " : "", tname_esc);
        add(out, len, ttmp);
        written++;
    }
#endif
}

#if defined HUD_REPRO_TEST
// Local repro: drive the dodx forward sequence + seed a synthetic captor.
//   amx_hud_test_cap <cp> <new_owner> <old_owner> [steamid] [name]
// Order matters: the cp_captured forward fires FIRST (a buggy synchronous
// build sees the still-empty batch -> captor_ids:[]). The synthetic captor is
// seeded AFTER, simulating dod_score_event's ~0.25s-deferred fill — so the
// fixed (deferred-emission) build picks it up when the per-CP task fires.
public cmd_test_cap(id, level, cid) {
    if (!cmd_access(id, level, cid, 4)) return PLUGIN_HANDLED;

    new acp[8], anew[8], aold[8];
    read_argv(1, acp,  charsmax(acp));
    read_argv(2, anew, charsmax(anew));
    read_argv(3, aold, charsmax(aold));
    new cp = str_to_num(acp);

    // 1. Fire the real dod_control_point_captured forward (sync, like the engine).
    dodx_test_dispatch_cp_captured(cp, str_to_num(anew), str_to_num(aold));

    // 2. Seed a synthetic captor (stand-in for dod_score_event's deferred fill).
    if (read_argc() >= 5 && cp >= 0 && cp < MAX_FLAGS) {
        new n = g_flag_test_count[cp];
        if (n < MAX_CAPTORS) {
            read_argv(4, g_flag_test_sid[cp][n], charsmax(g_flag_test_sid[][]));
            if (read_argc() >= 6) read_argv(5, g_flag_test_name[cp][n], charsmax(g_flag_test_name[][]));
            else copy(g_flag_test_name[cp][n], charsmax(g_flag_test_name[][]), g_flag_test_sid[cp][n]);
            g_flag_test_count[cp] = n + 1;
        }
    }
    return PLUGIN_HANDLED;
}
#endif

// ─── Caster Observed Player ──────────────────────────────────────────────────

public cmd_dump_zones(id, level, cid) {
    if (!cmd_access(id, ADMIN_RCON, cid, 1)) return PLUGIN_HANDLED;

    server_print("[HUD] zone dump (count=%d)", g_flag_count);

    for (new f = 0; f < g_flag_count && f < MAX_FLAGS; f++) {
        new dx = g_cp_dodx_of_dll[f];
        new ac = dodx_area_get_data(dx, CA_num_allies);
        new xc = dodx_area_get_data(dx, CA_num_axis);
        new an = dodx_area_get_data(dx, CA_allies_numcap);
        new xn = dodx_area_get_data(dx, CA_axis_numcap);
        new isc = dodx_area_get_data(dx, CA_is_capturing);
        new ct  = dodx_area_get_data(dx, CA_capturing_team);
        new ot  = dodx_area_get_data(dx, CA_owning_team);
        new Float:tr = Float:dodx_area_get_data(dx, CA_time_remaining);
        new ct_total = dodx_area_get_data(dx, CA_timetocap);

        server_print("[HUD] CP[%d] (dodx[%d]) '%s' own=%d cap=%d/team=%d  a=%d/%d x=%d/%d  t=%.1f/%d  committed=%d",
            f, dx, g_flag_name_cache[f], ot, isc, ct, ac, an, xc, xn,
            tr, ct_total, g_flag_capping_team[f]);
    }
    return PLUGIN_HANDLED;
}

public cmd_statsboard(id, level, cid) {
    if (!cmd_access(id, ADMIN_RCON, cid, 1)) return PLUGIN_HANDLED;

    emit_stats_summary(SUMMARY_MANUAL);
    console_print(id, "[HUD] stats summary emitted (reason=manual)");
    return PLUGIN_HANDLED;
}

public cmd_observe(id, level, cid) {
    if (!cmd_access(id, ADMIN_RCON, cid, 2)) return PLUGIN_HANDLED;

    new arg[32];
    read_argv(1, arg, charsmax(arg));

    new json[128];
    formatex(json, charsmax(json),
        "{^"event^":^"caster_observed_player^",^"user_id^":^"%s^"}", arg);
    post_event(json);

    return PLUGIN_HANDLED;
}
