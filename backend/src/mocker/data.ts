/**
 * DoD HUD Observer — Mocker Event Sequence
 *
 * Simulates a realistic 6v6 DoD match (both halves).
 * Times are in milliseconds from mocker start.
 *
 * Event shapes mirror what KTPHudObserver.amxx actually emits in extension mode.
 * Verified against production fixture: match-1777342963-NY1 (8997 events, 2026-04-27).
 *
 * Production deviations codified:
 *   - NEVER emitted: round_start_freeze, round_start, round_end, weapon_pickup,
 *     weapon_drop, nade_throw, flag_cap_contested. These are documented in
 *     CLAUDE.md but dead code in the plugin (confimed 0 occurrences across
 *     production fixture).
 *   - flags_init re-emitted per-round (47× in fixture, 6 H1 + 41 H2), not once.
 *   - team_score and player_score are the dominant events (1444 and 1306 occurrences).
 *     flag_zone_players is the highest frequency (2609/8997 = 29% of all traffic).
 *   - damage.victim_health ranges into negatives on overkill (e.g. -398 in fixture).
 *   - kill events always carry headshot + killer_prone + victim_prone (CLAUDE.md
 *     schema was incomplete — only listed victim_prone).
 *   - player_team_change can emit team: "spectator" (codified in production fixture).
 *   - prone_change emits state: "standing" on player spawn, not just transitions.
 *
 * Extension-mode constraints:
 *   - flag_zone_players carries integer counts (allies_count/axis_count), NOT id arrays.
 *     Per-player zone membership isn't readable in extension mode.
 *   - flag_cap_started.captor_ids is always []. Captor names only surface on
 *     flag_captured.captor_ids, populated by dod_score_event post-cap.
 *   - flags_init.flag_name uses raw BSP entity strings (e.g. POINT_ANZIO_PLAZA).
 *     All dod_anzio flags initialise as "neutral" — a property of THAT map's BSP,
 *     not of the format: dod_kalt/donner/flash start with their home flags owned.
 *   - flags_init.reason tags how authoritative the snapshot is (map_load /
 *     match_start / reset / tick); see CLAUDE.md. The fixture predates the field,
 *     so the two snapshots here are tagged by hand to keep the stream schema-valid
 *     against the flags-init-reason invariant.
 *
 * Fields the plugin injects on every emit (tick, plugin_sent_at, match_id, map,
 * match_type, half) are NOT authored here — mocker.ts adds them at send time.
 *
 * To run: npm run mocker
 */

export default [

    // ══════════════════════════════════════════════════════════════════════════
    // ══  HALF 1  (Allies = team 1001-1006, Axis = team 2001-2006)  ═════════
    // ══════════════════════════════════════════════════════════════════════════

    { "half_start": { "time": 50, "half": 1, "timeleft": 1200 } },

    // Plugin's post-half_start team_score seed — fresh match opens at 0/0.
    { "team_score": { "time": 51, "allies_score": 0, "axis_score": 0 } },

    // ── Players connect ──────────────────────────────────────────────────────
    // Real plugin: clients connect as "spectator" then player_team_change moves them.
    // Mocker shortcut: connect straight onto a team — backend treats both shapes the same.
    { "player_connect": { "time": 100,  "user_id": "STEAM_0:0:1001", "name": "Raphinha",  "team": "allies" } },
    { "player_connect": { "time": 150,  "user_id": "STEAM_0:0:1002", "name": "bud",       "team": "allies" } },
    { "player_connect": { "time": 200,  "user_id": "STEAM_0:0:1003", "name": "ORTIN",     "team": "allies" } },
    { "player_connect": { "time": 250,  "user_id": "STEAM_0:0:1004", "name": "storm",     "team": "allies" } },
    { "player_connect": { "time": 300,  "user_id": "STEAM_0:0:1005", "name": "MaT*",      "team": "allies" } },
    { "player_connect": { "time": 350,  "user_id": "STEAM_0:0:1006", "name": "BitchX",    "team": "allies" } },
    { "player_connect": { "time": 400,  "user_id": "STEAM_0:0:2001", "name": "mogers",    "team": "axis" } },
    { "player_connect": { "time": 450,  "user_id": "STEAM_0:0:2002", "name": "omenator",  "team": "axis" } },
    { "player_connect": { "time": 500,  "user_id": "STEAM_0:0:2003", "name": "E t",       "team": "axis" } },
    { "player_connect": { "time": 550,  "user_id": "STEAM_0:0:2004", "name": "bad",       "team": "axis" } },
    { "player_connect": { "time": 600,  "user_id": "STEAM_0:0:2005", "name": "Polak",     "team": "axis" } },
    { "player_connect": { "time": 650,  "user_id": "STEAM_0:0:2006", "name": "ian",       "team": "axis" } },

    // ── Round 1 ──────────────────────────────────────────────────────────────

    // dod_anzio: 5 cap zones, all start neutral (its BSP sets no point_default_owner
    // on any CP — unlike dod_kalt/donner/flash, where the home flags start owned).
    // flag_name = BSP entity string. `reason` says how far the overlay trusts the
    // snapshot; see the flags_init table in CLAUDE.md.
    { "flags_init": { "time": 1100, "reason": "map_load", "flags": [
        { "flag_id": 0, "flag_name": "POINT_ANZIO_PLAZA",   "owner": "neutral" },
        { "flag_id": 1, "flag_name": "POINT_ANZIO_STREET",  "owner": "neutral" },
        { "flag_id": 2, "flag_name": "POINT_ANZIO_HILL",    "owner": "neutral" },
        { "flag_id": 3, "flag_name": "POINT_BRIDGE",        "owner": "neutral" },
        { "flag_id": 4, "flag_name": "POINT_ANZIO_LAUNDRY", "owner": "neutral" },
    ]}},

    // dod_player_spawn forward includes `name` (verified in plugin source line 466).
    { "player_spawn": { "time": 1200, "user_id": "STEAM_0:0:1001", "name": "Raphinha", "team": "allies", "class_id": 0, "weapon_primary": "garand",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 1200, "user_id": "STEAM_0:0:1002", "name": "bud",      "team": "allies", "class_id": 2, "weapon_primary": "thompson", "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 1200, "user_id": "STEAM_0:0:1003", "name": "ORTIN",    "team": "allies", "class_id": 0, "weapon_primary": "garand",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 1200, "user_id": "STEAM_0:0:1004", "name": "storm",    "team": "allies", "class_id": 4, "weapon_primary": "spring",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 1200, "user_id": "STEAM_0:0:1005", "name": "MaT*",     "team": "allies", "class_id": 2, "weapon_primary": "thompson", "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 1200, "user_id": "STEAM_0:0:1006", "name": "BitchX",   "team": "allies", "class_id": 0, "weapon_primary": "garand",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 1200, "user_id": "STEAM_0:0:2001", "name": "mogers",   "team": "axis",   "class_id": 0, "weapon_primary": "kar",      "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 1200, "user_id": "STEAM_0:0:2002", "name": "omenator", "team": "axis",   "class_id": 2, "weapon_primary": "mp40",     "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 1200, "user_id": "STEAM_0:0:2003", "name": "E t",      "team": "axis",   "class_id": 0, "weapon_primary": "kar",      "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 1200, "user_id": "STEAM_0:0:2004", "name": "bad",      "team": "axis",   "class_id": 3, "weapon_primary": "mp44",     "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 1200, "user_id": "STEAM_0:0:2005", "name": "Polak",    "team": "axis",   "class_id": 0, "weapon_primary": "kar",      "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 1200, "user_id": "STEAM_0:0:2006", "name": "ian",      "team": "axis",   "class_id": 6, "weapon_primary": "mg42",     "weapon_secondary": "luger" } },

    { "caster_observed_player": { "time": 4500, "user_id": "STEAM_0:0:1001" } },

    // weapon_active (Phase 1, NEW): emitted by the dod_client_weaponswitch public
    // on every weapon switch. Raw dodx lognames; the HUD's WEAPON_ALIASES normalizes.
    // Not in the production fixture (this is a new feature) — authored here for the HUD.
    // storm (sniper) pulls pistol then re-scopes; bud swaps to knife; mogers throws to nade.
    { "weapon_active": { "time": 5200, "user_id": "STEAM_0:0:1004", "weapon": "colt" } },
    { "weapon_active": { "time": 5600, "user_id": "STEAM_0:0:1002", "weapon": "amerknife" } },
    { "weapon_active": { "time": 5900, "user_id": "STEAM_0:0:2001", "weapon": "grenade2" } },

    // ian goes prone (shame!). Real plugin sets timestamp = get_systime()*1000 (wall clock).
    { "prone_change": { "time": 6000,  "user_id": "STEAM_0:0:2006", "state": "prone", "timestamp": 1741420806000 } },

    // Switch back to primaries before the engagement.
    { "weapon_active": { "time": 7200, "user_id": "STEAM_0:0:1004", "weapon": "spring" } },
    { "weapon_active": { "time": 7400, "user_id": "STEAM_0:0:1002", "weapon": "thompson" } },
    { "weapon_active": { "time": 7600, "user_id": "STEAM_0:0:2001", "weapon": "kar" } },

    // player_state (Phase 2, NEW): the 4 Hz batched per-player snapshot emitted by
    // task_poll_player_state. Carries live held weapon + grenade count for
    // every ALIVE player (dead players are omitted — their cards stay in the dead
    // state). Socket-only on the backend (never written to events.jsonl). The real
    // plugin emits this 4×/sec; the mocker authors a few representative snapshots.
    { "player_state": { "time": 4800, "players": [
        { "user_id": "STEAM_0:0:1001", "weapon": "garand",   "nades": 2, "health": 100, "prone_state": "standing" },
        { "user_id": "STEAM_0:0:1002", "weapon": "thompson", "nades": 2, "health": 100, "prone_state": "standing" },
        { "user_id": "STEAM_0:0:1003", "weapon": "garand",   "nades": 2, "health": 100, "prone_state": "standing" },
        { "user_id": "STEAM_0:0:1004", "weapon": "spring",   "nades": 1, "health": 100, "prone_state": "standing" },
        { "user_id": "STEAM_0:0:1005", "weapon": "thompson", "nades": 2, "health": 100, "prone_state": "standing" },
        { "user_id": "STEAM_0:0:1006", "weapon": "garand",   "nades": 2, "health": 100, "prone_state": "standing" },
        { "user_id": "STEAM_0:0:2001", "weapon": "kar",      "nades": 2, "health": 100, "prone_state": "standing" },
        { "user_id": "STEAM_0:0:2002", "weapon": "mp40",     "nades": 2, "health": 100, "prone_state": "standing" },
        { "user_id": "STEAM_0:0:2003", "weapon": "kar",      "nades": 2, "health": 100, "prone_state": "standing" },
        { "user_id": "STEAM_0:0:2004", "weapon": "mp44",     "nades": 2, "health": 100, "prone_state": "standing" },
        { "user_id": "STEAM_0:0:2005", "weapon": "kar",      "nades": 2, "health": 100, "prone_state": "standing" },
        { "user_id": "STEAM_0:0:2006", "weapon": "mg42",     "nades": 1, "health": 100, "prone_state": "standing" },
    ]}},

    // Mid-round snapshot: 1003/2002/2006 are dead by now (kills at 9s/10s/14s) and
    // are intentionally absent — a couple of nades thrown. First snapshot to carry
    // the `waves` block: the wave clock is per-TEAM and arms on each side's first
    // death, so the two sides have unrelated phases (the 4800 snapshot above has no
    // `waves` key at all — nobody was dead yet, so neither clock was running).
    //
    // Also the first to carry `scoring` — DoD's territorial point award for
    // holding control points. ONE shared clock (the map has a single
    // control-point master) plus each side's projected points, unlike `waves`,
    // which is two independent per-team phases.
    //
    // NOTE these fixtures author the ESTIMATOR'S OUTPUT, never its input. The
    // plugin reconstructs this clock from TeamScore broadcasts, and none of that
    // detection — the 0.5s grid test, the phase lock, the online learning of what
    // a control point is worth — is exercised by the mocker at all. Its only test
    // is backend/src/invariants/scoreTick.ts against the recorded fixture.
    { "player_state": { "time": 16000, "waves": {
        "allies": { "in": 3.75, "pending": 1 },
        "axis":   { "in": 8.25, "pending": 2 },
    }, "scoring": { "in": 21.25, "every": 30.5, "allies": 4, "axis": 2 }, "players": [
        { "user_id": "STEAM_0:0:1001", "weapon": "garand",   "nades": 1, "health": 74,  "prone_state": "standing" },
        { "user_id": "STEAM_0:0:1002", "weapon": "thompson", "nades": 2, "health": 100, "prone_state": "standing" },
        { "user_id": "STEAM_0:0:1004", "weapon": "spring",   "nades": 1, "health": 88,  "prone_state": "deployed" },
        { "user_id": "STEAM_0:0:1005", "weapon": "thompson", "nades": 1, "health": 100, "prone_state": "standing" },
        { "user_id": "STEAM_0:0:1006", "weapon": "garand",   "nades": 0, "health": 51,  "prone_state": "standing" },
        { "user_id": "STEAM_0:0:2001", "weapon": "kar",      "nades": 1, "health": 100, "prone_state": "standing" },
        { "user_id": "STEAM_0:0:2003", "weapon": "kar",      "nades": 2, "health": 62,  "prone_state": "standing" },
        { "user_id": "STEAM_0:0:2004", "weapon": "mp44",     "nades": 1, "health": 100, "prone_state": "standing" },
        { "user_id": "STEAM_0:0:2005", "weapon": "kar",      "nades": 2, "health": 90,  "prone_state": "standing" },
    ]}},

    // Scoring clock with NO award pair — the plugin has locked the tick phase but
    // has not corroborated what a control point is worth (an unvalidated map, a
    // dodx too old to report CP default owners, or `dod_hud_score_award 0`). The
    // countdown renders, the numbers stay dark. This degraded shape is the one
    // most likely to hit the fleet first and would otherwise never be seen locally.
    { "player_state": { "time": 19000,
      "scoring": { "in": 12.00, "every": 30.5 }, "players": [
        { "user_id": "STEAM_0:0:1001", "weapon": "garand",   "nades": 1, "health": 74,  "prone_state": "standing" },
        { "user_id": "STEAM_0:0:2001", "weapon": "kar",      "nades": 1, "health": 100, "prone_state": "standing" },
    ]}},

    // Post-trade snapshot: both sides are down bodies and the allies wave is about
    // to land — drives the pill's sub-3s "hot" state on the overlay. The scoring
    // tick is about to land too (sub-3s drives .tick-clock.hot), and axis are on
    // +0: they hold only their own home flags, which is real information, not an
    // absent value.
    { "player_state": { "time": 22500, "waves": {
        "allies": { "in": 1.25, "pending": 3 },
        "axis":   { "in": 6.50, "pending": 4 },
    }, "scoring": { "in": 2.75, "every": 30.5, "allies": 4, "axis": 0 }, "players": [
        { "user_id": "STEAM_0:0:1001", "weapon": "garand",   "nades": 1, "health": 74,  "prone_state": "standing" },
        { "user_id": "STEAM_0:0:1004", "weapon": "spring",   "nades": 0, "health": 88,  "prone_state": "deployed" },
        { "user_id": "STEAM_0:0:1006", "weapon": "garand",   "nades": 0, "health": 51,  "prone_state": "standing" },
        { "user_id": "STEAM_0:0:2001", "weapon": "kar",      "nades": 0, "health": 100, "prone_state": "standing" },
        { "user_id": "STEAM_0:0:2005", "weapon": "kar",      "nades": 2, "health": 90,  "prone_state": "standing" },
    ]}},

    // Pre-engagement zone state — zone polling is 10Hz live; we sample at ~1Hz here.
    { "flag_zone_players": { "time": 6500, "zones": [
        { "flag_id": 0, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 1, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 2, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 3, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 4, "allies_count": 0, "axis_count": 0 },
    ]}},

    // Chat: pre-round banter
    { "user_say": { "time": 6700, "user_id": "STEAM_0:0:1001", "team_only": false, "message": "gl hf" } },
    { "user_say": { "time": 7000, "user_id": "STEAM_0:0:2001", "team_only": false, "message": "hf" } },

    // Two axis enter Anzio Street zone
    { "flag_zone_players": { "time": 7800, "zones": [
        { "flag_id": 0, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 1, "allies_count": 0, "axis_count": 2 },
        { "flag_id": 2, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 3, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 4, "allies_count": 0, "axis_count": 0 },
    ]}},

    // Cap state transition: prev_capper 0 -> axis. captor_ids ALWAYS [] (ext-mode constraint).
    { "flag_cap_started": { "time": 8000, "flag_id": 1, "flag_name": "POINT_ANZIO_STREET", "capping_team": "axis", "captor_ids": [] } },

    { "flag_cap_progress": { "time": 8500, "flag_id": 1, "progress": 10, "capping_team": "axis" } },

    // Damage before kill.
    // Kills carry kill_class (nade|gun, from the plugin's is_nade_wpn) and
    // assist_ids (players who dealt 50+ enemy damage to the victim this life,
    // excluding the killer) — both NEW with the stats-popup feature.
    { "damage": { "time": 8800, "attacker_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1003", "damage": 100, "weapon": "kar", "hitplace": 1, "victim_health": 0 } },
    { "kill":   { "time": 9000, "killer_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1003", "weapon": "kar",    "kill_type": "normal", "kill_class": "gun", "headshot": true,  "victim_prone": false, "killer_prone": false, "assist_ids": [] } },

    { "flag_cap_progress": { "time": 9200, "flag_id": 1, "progress": 25, "capping_team": "axis" } },

    // Raphinha enters Anzio Street zone — cap contested.
    { "flag_zone_players": { "time": 9800, "zones": [
        { "flag_id": 0, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 1, "allies_count": 1, "axis_count": 2 },
        { "flag_id": 2, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 3, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 4, "allies_count": 0, "axis_count": 0 },
    ]}},

    // Raphinha kills omenator on the point
    { "damage": { "time": 9950, "attacker_id": "STEAM_0:0:1001", "victim_id": "STEAM_0:0:2002", "damage": 55, "weapon": "garand", "hitplace": 2, "victim_health": 45 } },
    { "damage": { "time": 10000, "attacker_id": "STEAM_0:0:1001", "victim_id": "STEAM_0:0:2002", "damage": 55, "weapon": "garand", "hitplace": 3, "victim_health": 0 } },
    { "kill":   { "time": 10000, "killer_id": "STEAM_0:0:1001", "victim_id": "STEAM_0:0:2002", "weapon": "garand", "kill_type": "normal", "kill_class": "gun", "headshot": false, "victim_prone": false, "killer_prone": false, "assist_ids": [] } },

    // Cap interrupted — last axis leaves zone
    { "flag_zone_players": { "time": 10300, "zones": [
        { "flag_id": 0, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 1, "allies_count": 1, "axis_count": 0 },
        { "flag_id": 2, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 3, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 4, "allies_count": 0, "axis_count": 0 },
    ]}},
    // Raphinha's kill removed a capper from the point (zone count 2 -> 0 above):
    // the plugin credits the killer once the drop shows up within the confirm
    // window, then emits his refreshed player_score carrying cap_breaks.
    { "cap_break": { "time": 10350, "flag_id": 1, "flag_name": "POINT_ANZIO_STREET", "reason": "kill", "breaker_id": "STEAM_0:0:1001", "broke_team": "axis" } },
    { "player_score": { "time": 10400, "user_id": "STEAM_0:0:1001", "kills": 1, "deaths": 0, "score": 1, "obj_score": 0, "damage": 110, "assists": 0, "hs_kills": 0, "nade_kills": 0, "gun_kills": 1, "hits": 2, "hs_hits": 0, "caps": 0, "cap_breaks": 1, "best_streak": 1 } },
    { "flag_cap_stopped": { "time": 10500, "flag_id": 1, "flag_name": "POINT_ANZIO_STREET", "capping_team": "axis" } },

    // Team chat
    { "user_say": { "time": 11500, "user_id": "STEAM_0:0:1001", "team_only": true, "message": "picked up mp40, pushing street" } },

    // Allies push onto the Street
    { "flag_zone_players": { "time": 12500, "zones": [
        { "flag_id": 0, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 1, "allies_count": 2, "axis_count": 0 },
        { "flag_id": 2, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 3, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 4, "allies_count": 0, "axis_count": 0 },
    ]}},
    { "flag_cap_started": { "time": 13000, "flag_id": 1, "flag_name": "POINT_ANZIO_STREET", "capping_team": "allies", "captor_ids": [] } },
    { "flag_cap_progress": { "time": 13200, "flag_id": 1, "progress": 10, "capping_team": "allies" } },

    // ian still prone — killed while proning
    { "damage": { "time": 13900, "attacker_id": "STEAM_0:0:1004", "victim_id": "STEAM_0:0:2006", "damage": 100, "weapon": "spring", "hitplace": 1, "victim_health": 0 } },
    { "kill":   { "time": 14000, "killer_id": "STEAM_0:0:1004", "victim_id": "STEAM_0:0:2006", "weapon": "spring", "kill_type": "normal", "kill_class": "gun", "headshot": true, "victim_prone": true, "killer_prone": false, "assist_ids": [] } },

    { "flag_cap_progress": { "time": 14200, "flag_id": 1, "progress": 60, "capping_team": "allies" } },
    { "flag_cap_progress": { "time": 14700, "flag_id": 1, "progress": 90, "capping_team": "allies" } },

    // Allies cap the Street. captor_ids is the ONLY place names appear — sourced from
    // dod_score_event in the live plugin. team_score fires alongside flag_captured.
    { "flag_captured": { "time": 15000, "flag_id": 1, "flag_name": "POINT_ANZIO_STREET", "new_owner": "allies", "captor_ids": ["STEAM_0:0:1001", "STEAM_0:0:1002"] } },
    { "team_score":    { "time": 15000, "allies_score": 1, "axis_score": 0 } },

    { "flag_zone_players": { "time": 15100, "zones": [
        { "flag_id": 0, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 1, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 2, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 3, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 4, "allies_count": 0, "axis_count": 0 },
    ]}},

    // Per-player score updates (ScoreShort event in plugin)
    // Captors of the Street cap (1001, 1002) get +5 obj_score + caps:1, mirroring
    // dod_score_event. player_score carries the stat accumulators (incl. caps +
    // best_streak); old-plugin events without them still work (?? 0 fallback).
    // NOTE: per-single-flag-cap stats popups were REMOVED — cumulative stats now
    // appear on the capout board (round_end) and at half/match end.
    { "player_score": { "time": 15200, "user_id": "STEAM_0:0:2001", "kills": 1, "deaths": 0, "score": 1, "obj_score": 0, "damage": 100, "assists": 0, "hs_kills": 1, "nade_kills": 0, "gun_kills": 1, "hits": 1, "hs_hits": 1, "caps": 0, "best_streak": 1 } },
    { "player_score": { "time": 15200, "user_id": "STEAM_0:0:1001", "kills": 1, "deaths": 0, "score": 7, "obj_score": 5, "damage": 110, "assists": 0, "hs_kills": 0, "nade_kills": 0, "gun_kills": 1, "hits": 2, "hs_hits": 0, "caps": 1, "cap_breaks": 1, "best_streak": 1 } },
    { "player_score": { "time": 15200, "user_id": "STEAM_0:0:1002", "kills": 0, "deaths": 0, "score": 5, "obj_score": 5, "damage": 0, "assists": 0, "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0, "caps": 1, "best_streak": 0 } },
    { "player_score": { "time": 15200, "user_id": "STEAM_0:0:1004", "kills": 1, "deaths": 0, "score": 1, "obj_score": 0, "damage": 100, "assists": 0, "hs_kills": 1, "nade_kills": 0, "gun_kills": 1, "hits": 1, "hs_hits": 1 } },
    { "player_score": { "time": 15200, "user_id": "STEAM_0:0:1003", "kills": 0, "deaths": 1, "score": 0, "obj_score": 0, "damage": 0, "assists": 0, "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0 } },
    { "player_score": { "time": 15200, "user_id": "STEAM_0:0:2002", "kills": 0, "deaths": 1, "score": 0, "obj_score": 0, "damage": 0, "assists": 0, "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0 } },
    { "player_score": { "time": 15200, "user_id": "STEAM_0:0:2006", "kills": 0, "deaths": 1, "score": 0, "obj_score": 0, "damage": 0, "assists": 0, "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0 } },

    // Tick-scoring re-broadcast — DoD periodically re-emits TeamScore for a
    // held flag with the same value, mostly as a sync nudge. The frontend
    // should be idempotent (same value → no visible change).
    { "team_score": { "time": 17000, "allies_score": 1, "axis_score": 0 } },

    // More fighting — assist sequence: "E t" softens bud with 55, "bad" finishes
    // him → the kill carries assist_ids ["STEAM_0:0:2003"] and the kill feed
    // shows "bad + E t".
    { "damage": { "time": 17700, "attacker_id": "STEAM_0:0:2003", "victim_id": "STEAM_0:0:1002", "damage": 55, "weapon": "kar",  "hitplace": 2, "victim_health": 45 } },
    { "damage": { "time": 17800, "attacker_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1002", "damage": 25, "weapon": "mp44", "hitplace": 3, "victim_health": 20 } },
    { "damage": { "time": 18000, "attacker_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1002", "damage": 20, "weapon": "mp44", "hitplace": 2, "victim_health": 0 } },
    { "kill":   { "time": 18000, "killer_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1002", "weapon": "mp44",   "kill_type": "normal", "kill_class": "gun", "headshot": false, "victim_prone": false, "killer_prone": false, "assist_ids": ["STEAM_0:0:2003"] } },
    // Plugin emits player_score for the assister too (same pattern as cap credit).
    { "player_score": { "time": 18100, "user_id": "STEAM_0:0:2003", "kills": 0, "deaths": 0, "score": 0, "obj_score": 0, "damage": 55, "assists": 1, "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 1, "hs_hits": 0 } },
    { "damage": { "time": 18900, "attacker_id": "STEAM_0:0:1006", "victim_id": "STEAM_0:0:2003", "damage": 100, "weapon": "garand", "hitplace": 1, "victim_health": 0 } },
    { "kill":   { "time": 19000, "killer_id": "STEAM_0:0:1006", "victim_id": "STEAM_0:0:2003", "weapon": "garand", "kill_type": "normal", "kill_class": "gun", "headshot": true,  "victim_prone": false, "killer_prone": false, "assist_ids": [] } },
    // mogers 2nd kill this round — streak
    { "damage": { "time": 19900, "attacker_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1005", "damage": 100, "weapon": "kar", "hitplace": 2, "victim_health": 0 } },
    { "kill":   { "time": 20000, "killer_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1005", "weapon": "kar",    "kill_type": "normal", "kill_class": "gun", "headshot": false, "victim_prone": false, "killer_prone": false, "assist_ids": [] } },

    // Teamkill — kill carries killer_tk_count (Polak's running TK total this
    // half). The kill feed shows "Polak (TK x1)". Polak TKs again at 21800 →
    // "(TK x2)", demonstrating the running count the caster asked for.
    { "kill":     { "time": 21000, "killer_id": "STEAM_0:0:2005", "victim_id": "STEAM_0:0:2004", "weapon": "kar",  "kill_type": "teamkill", "kill_class": "gun", "headshot": false, "victim_prone": false, "killer_prone": false, "killer_tk_count": 1, "assist_ids": [] } },
    { "user_say": { "time": 21500, "user_id": "STEAM_0:0:2004", "team_only": true, "message": "WTF POLAK" } },
    { "kill":     { "time": 21800, "killer_id": "STEAM_0:0:2005", "victim_id": "STEAM_0:0:2002", "weapon": "kar",  "kill_type": "teamkill", "kill_class": "gun", "headshot": false, "victim_prone": false, "killer_prone": false, "killer_tk_count": 2, "assist_ids": [] } },

    // Self-frag — BitchX cooks a grenade too long and blows himself up. DODX
    // attributes the nade (weapon "grenade", killer == victim), so the kill feed
    // shows skull + grenade icon, not a bare generic suicide.
    { "kill": { "time": 23000, "killer_id": "STEAM_0:0:1006", "victim_id": "STEAM_0:0:1006", "weapon": "grenade", "kill_type": "suicide", "kill_class": "nade", "headshot": false, "victim_prone": false, "killer_prone": false, "assist_ids": [] } },

    // Nade kill — mogers lands a stick grenade on storm (kill_class "nade",
    // feeds the nade-kills column on the stats boards).
    { "damage": { "time": 24400, "attacker_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1004", "damage": 97, "weapon": "grenade2", "hitplace": 0, "victim_health": 0 } },
    { "kill":   { "time": 24500, "killer_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1004", "weapon": "grenade2", "kill_type": "normal", "kill_class": "nade", "headshot": false, "victim_prone": false, "killer_prone": false, "assist_ids": [] } },

    // Zone re-poll mid-round
    { "flag_zone_players": { "time": 22000, "zones": [
        { "flag_id": 0, "allies_count": 1, "axis_count": 0 },
        { "flag_id": 1, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 2, "allies_count": 0, "axis_count": 1 },
        { "flag_id": 3, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 4, "allies_count": 0, "axis_count": 0 },
    ]}},

    // Time sync (real plugin emits every ~30s)
    { "time_sync": { "time": 25000, "timeleft": 1175 } },

    // Tick-scoring increment — DoD bumps team score every ~10-20s for held
    // flags. Allies still hold Anzio Street, so they tick to 2.
    { "team_score": { "time": 25500, "allies_score": 2, "axis_score": 0 } },

    // ── Player disconnect / reconnect ────────────────────────────────────────
    { "player_disconnect": { "time": 27000, "user_id": "STEAM_0:0:2005" } },
    { "player_connect":    { "time": 29000, "user_id": "STEAM_0:0:2005", "name": "Polak", "team": "axis" } },

    // ── Round 2 ──────────────────────────────────────────────────────────────

    { "player_spawn": { "time": 35500, "user_id": "STEAM_0:0:1001", "name": "Raphinha", "team": "allies", "class_id": 0, "weapon_primary": "garand",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 35500, "user_id": "STEAM_0:0:1002", "name": "bud",      "team": "allies", "class_id": 2, "weapon_primary": "thompson", "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 35500, "user_id": "STEAM_0:0:1003", "name": "ORTIN",    "team": "allies", "class_id": 0, "weapon_primary": "garand",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 35500, "user_id": "STEAM_0:0:1004", "name": "storm",    "team": "allies", "class_id": 4, "weapon_primary": "spring",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 35500, "user_id": "STEAM_0:0:1005", "name": "MaT*",     "team": "allies", "class_id": 2, "weapon_primary": "thompson", "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 35500, "user_id": "STEAM_0:0:1006", "name": "BitchX",   "team": "allies", "class_id": 0, "weapon_primary": "garand",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 35500, "user_id": "STEAM_0:0:2001", "name": "mogers",   "team": "axis",   "class_id": 0, "weapon_primary": "kar",      "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 35500, "user_id": "STEAM_0:0:2002", "name": "omenator", "team": "axis",   "class_id": 2, "weapon_primary": "mp40",     "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 35500, "user_id": "STEAM_0:0:2003", "name": "E t",      "team": "axis",   "class_id": 0, "weapon_primary": "kar",      "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 35500, "user_id": "STEAM_0:0:2004", "name": "bad",      "team": "axis",   "class_id": 3, "weapon_primary": "mp44",     "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 35500, "user_id": "STEAM_0:0:2005", "name": "Polak",    "team": "axis",   "class_id": 0, "weapon_primary": "kar",      "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 35500, "user_id": "STEAM_0:0:2006", "name": "ian",      "team": "axis",   "class_id": 6, "weapon_primary": "mg42",     "weapon_secondary": "luger" } },

    // Round 2 carryover — score continues from round 1's 2-0.
    { "team_score":  { "time": 38100, "allies_score": 2, "axis_score": 0 } },

    // Axis push hard — quick kills
    { "damage": { "time": 41900, "attacker_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1001", "damage": 100, "weapon": "kar", "hitplace": 1, "victim_health": 0 } },
    { "kill":   { "time": 42000, "killer_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1001", "weapon": "kar",  "kill_type": "normal", "kill_class": "gun", "headshot": true,  "victim_prone": false, "killer_prone": false, "assist_ids": [] } },
    { "damage": { "time": 42800, "attacker_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1006", "damage": 40, "weapon": "mp44", "hitplace": 4, "victim_health": 60 } },
    { "damage": { "time": 42900, "attacker_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1006", "damage": 40, "weapon": "mp44", "hitplace": 2, "victim_health": 20 } },
    { "damage": { "time": 43000, "attacker_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1006", "damage": 40, "weapon": "mp44", "hitplace": 3, "victim_health": 0 } },
    { "kill":   { "time": 43000, "killer_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1006", "weapon": "mp44", "kill_type": "normal", "kill_class": "gun", "headshot": false, "victim_prone": false, "killer_prone": true, "assist_ids": [] } },
    { "damage": { "time": 43900, "attacker_id": "STEAM_0:0:2002", "victim_id": "STEAM_0:0:1005", "damage": 30, "weapon": "mp40", "hitplace": 5, "victim_health": 70 } },
    { "damage": { "time": 44000, "attacker_id": "STEAM_0:0:2002", "victim_id": "STEAM_0:0:1005", "damage": 30, "weapon": "mp40", "hitplace": 2, "victim_health": 40 } },
    { "damage": { "time": 44000, "attacker_id": "STEAM_0:0:2002", "victim_id": "STEAM_0:0:1005", "damage": 40, "weapon": "mp40", "hitplace": 2, "victim_health": 0 } },
    { "kill":   { "time": 44000, "killer_id": "STEAM_0:0:2002", "victim_id": "STEAM_0:0:1005", "weapon": "mp40", "kill_type": "normal", "kill_class": "gun", "headshot": false, "victim_prone": false, "killer_prone": false, "assist_ids": [] } },

    // Axis cap the Street back. captor_ids: [] until flag_captured fires.
    { "flag_zone_players": { "time": 44500, "zones": [
        { "flag_id": 0, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 1, "allies_count": 0, "axis_count": 2 },
        { "flag_id": 2, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 3, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 4, "allies_count": 0, "axis_count": 0 },
    ]}},
    { "flag_cap_started":  { "time": 45000, "flag_id": 1, "flag_name": "POINT_ANZIO_STREET", "capping_team": "axis", "captor_ids": [] } },
    { "flag_cap_progress": { "time": 45500, "flag_id": 1, "progress": 15, "capping_team": "axis" } },
    { "flag_cap_progress": { "time": 46000, "flag_id": 1, "progress": 35, "capping_team": "axis" } },
    { "flag_cap_progress": { "time": 46500, "flag_id": 1, "progress": 55, "capping_team": "axis" } },
    { "flag_cap_progress": { "time": 47000, "flag_id": 1, "progress": 75, "capping_team": "axis" } },
    { "flag_cap_progress": { "time": 47500, "flag_id": 1, "progress": 95, "capping_team": "axis" } },
    { "flag_captured":     { "time": 48000, "flag_id": 1, "flag_name": "POINT_ANZIO_STREET", "new_owner": "axis", "captor_ids": ["STEAM_0:0:2001", "STEAM_0:0:2004"] } },
    // Axis recap: their first +1 against allies' 2 (1 cap + 1 tick) = 2-1.
    { "team_score":        { "time": 48000, "allies_score": 2, "axis_score": 1 } },

    // Captors of the Street recap (2001, 2004) get +5 obj_score + caps:1.
    // mogers (2001) strung 4 kills → best_streak 4.
    { "player_score": { "time": 48200, "user_id": "STEAM_0:0:2001", "kills": 4, "deaths": 0, "score": 9, "obj_score": 5, "damage": 397, "assists": 0, "hs_kills": 2, "nade_kills": 1, "gun_kills": 3, "hits": 4, "hs_hits": 2, "caps": 1, "best_streak": 4 } },
    { "player_score": { "time": 48200, "user_id": "STEAM_0:0:2004", "kills": 2, "deaths": 1, "score": 7, "obj_score": 5, "damage": 165, "assists": 0, "hs_kills": 0, "nade_kills": 0, "gun_kills": 2, "hits": 5, "hs_hits": 0, "caps": 1, "best_streak": 2 } },

    { "time_sync": { "time": 56000, "timeleft": 1145 } },

    // half_end (NEW): the plugin detects KTPMatchHandler's KTP_HALF_END log line
    // (fires only at half-1 end, at the moment gameplay ends, before the
    // changelevel) and emits half_end + a half_end stats summary. The frontend
    // auto-shows the halftime stats board off the summary, then dismisses it
    // when half 2 goes live (half_start below).
    { "half_end": { "time": 57000, "half": 1, "allies_score": 2, "axis_score": 1 } },
    { "player_stats_summary": { "time": 57050, "reason": "half_end", "players": [
        { "user_id": "STEAM_0:0:1001", "name": "Raphinha", "team": "allies", "kills": 1, "deaths": 1, "assists": 0, "damage": 110, "hs_kills": 0, "nade_kills": 0, "gun_kills": 1, "hits": 2, "hs_hits": 0, "obj_score": 5, "caps": 1, "cap_breaks": 1, "best_streak": 1 },
        { "user_id": "STEAM_0:0:1002", "name": "bud",      "team": "allies", "kills": 0, "deaths": 1, "assists": 0, "damage": 0,   "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0, "obj_score": 5, "caps": 1, "best_streak": 0 },
        { "user_id": "STEAM_0:0:1003", "name": "ORTIN",    "team": "allies", "kills": 0, "deaths": 1, "assists": 0, "damage": 0,   "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0, "obj_score": 0, "caps": 0, "best_streak": 0 },
        { "user_id": "STEAM_0:0:1004", "name": "storm",    "team": "allies", "kills": 1, "deaths": 1, "assists": 0, "damage": 100, "hs_kills": 1, "nade_kills": 0, "gun_kills": 1, "hits": 1, "hs_hits": 1, "obj_score": 0, "caps": 0, "best_streak": 1 },
        { "user_id": "STEAM_0:0:1005", "name": "MaT*",     "team": "allies", "kills": 0, "deaths": 2, "assists": 0, "damage": 0,   "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0, "obj_score": 0, "caps": 0, "best_streak": 0 },
        { "user_id": "STEAM_0:0:1006", "name": "BitchX",   "team": "allies", "kills": 1, "deaths": 2, "assists": 0, "damage": 140, "hs_kills": 1, "nade_kills": 0, "gun_kills": 1, "hits": 2, "hs_hits": 1, "obj_score": 0, "caps": 0, "best_streak": 1 },
        { "user_id": "STEAM_0:0:2001", "name": "mogers",   "team": "axis",   "kills": 4, "deaths": 0, "assists": 0, "damage": 397, "hs_kills": 2, "nade_kills": 1, "gun_kills": 3, "hits": 4, "hs_hits": 2, "obj_score": 5, "caps": 1, "best_streak": 4 },
        { "user_id": "STEAM_0:0:2002", "name": "omenator", "team": "axis",   "kills": 1, "deaths": 1, "assists": 0, "damage": 100, "hs_kills": 0, "nade_kills": 0, "gun_kills": 1, "hits": 3, "hs_hits": 0, "obj_score": 0, "caps": 0, "best_streak": 1 },
        { "user_id": "STEAM_0:0:2003", "name": "E t",      "team": "axis",   "kills": 0, "deaths": 1, "assists": 1, "damage": 55,  "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 1, "hs_hits": 0, "obj_score": 0, "caps": 0, "best_streak": 0 },
        { "user_id": "STEAM_0:0:2004", "name": "bad",      "team": "axis",   "kills": 2, "deaths": 1, "assists": 0, "damage": 165, "hs_kills": 0, "nade_kills": 0, "gun_kills": 2, "hits": 5, "hs_hits": 0, "obj_score": 5, "caps": 1, "best_streak": 2 },
        { "user_id": "STEAM_0:0:2005", "name": "Polak",    "team": "axis",   "kills": 0, "deaths": 0, "assists": 0, "damage": 0,   "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0, "obj_score": 0, "caps": 0, "best_streak": 0 },
        { "user_id": "STEAM_0:0:2006", "name": "ian",      "team": "axis",   "kills": 0, "deaths": 1, "assists": 0, "damage": 0,   "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0, "obj_score": 0, "caps": 0, "best_streak": 0 },
    ]}},


    // ══════════════════════════════════════════════════════════════════════════
    // ══  HALF 2  (teams swap sides — 1001-1006 now Axis, 2001-2006 now Allies)
    // ══════════════════════════════════════════════════════════════════════════

    { "half_start": { "time": 62000, "half": 2, "timeleft": 1200 } },

    // Plugin's post-half_start team_score seed — half 1 ended 2-1, score
    // carries into half 2 immediately so the HUD doesn't flicker to 0-0.
    { "team_score": { "time": 62050, "allies_score": 2, "axis_score": 1 } },

    // Team changes — each player moves to the opposite side
    { "player_team_change": { "time": 62100, "user_id": "STEAM_0:0:1001", "team": "axis" } },
    { "player_team_change": { "time": 62100, "user_id": "STEAM_0:0:1002", "team": "axis" } },
    { "player_team_change": { "time": 62100, "user_id": "STEAM_0:0:1003", "team": "axis" } },
    { "player_team_change": { "time": 62100, "user_id": "STEAM_0:0:1004", "team": "axis" } },
    { "player_team_change": { "time": 62100, "user_id": "STEAM_0:0:1005", "team": "axis" } },
    { "player_team_change": { "time": 62100, "user_id": "STEAM_0:0:1006", "team": "axis" } },
    { "player_team_change": { "time": 62100, "user_id": "STEAM_0:0:2001", "team": "allies" } },
    { "player_team_change": { "time": 62100, "user_id": "STEAM_0:0:2002", "team": "allies" } },
    { "player_team_change": { "time": 62100, "user_id": "STEAM_0:0:2003", "team": "allies" } },
    { "player_team_change": { "time": 62100, "user_id": "STEAM_0:0:2004", "team": "allies" } },
    { "player_team_change": { "time": 62100, "user_id": "STEAM_0:0:2005", "team": "allies" } },
    { "player_team_change": { "time": 62100, "user_id": "STEAM_0:0:2006", "team": "allies" } },

    // ── Half 2, Round 1 ──────────────────────────────────────────────────────
    // Production: flags_init is re-emitted per round (47× in fixture, 6 H1 + 41 H2).

    { "flags_init": { "time": 63100, "reason": "match_start", "flags": [
        { "flag_id": 0, "flag_name": "POINT_ANZIO_PLAZA",   "owner": "neutral" },
        { "flag_id": 1, "flag_name": "POINT_ANZIO_STREET",  "owner": "neutral" },
        { "flag_id": 2, "flag_name": "POINT_ANZIO_HILL",    "owner": "neutral" },
        { "flag_id": 3, "flag_name": "POINT_BRIDGE",        "owner": "neutral" },
        { "flag_id": 4, "flag_name": "POINT_ANZIO_LAUNDRY", "owner": "neutral" },
    ]}},

    // Spawns — teams swapped (1001-1006 now axis classes, 2001-2006 now allied classes)
    { "player_spawn": { "time": 63200, "user_id": "STEAM_0:0:2001", "name": "mogers",   "team": "allies", "class_id": 0, "weapon_primary": "garand",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 63200, "user_id": "STEAM_0:0:2002", "name": "omenator", "team": "allies", "class_id": 2, "weapon_primary": "thompson", "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 63200, "user_id": "STEAM_0:0:2003", "name": "E t",      "team": "allies", "class_id": 0, "weapon_primary": "garand",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 63200, "user_id": "STEAM_0:0:2004", "name": "bad",      "team": "allies", "class_id": 2, "weapon_primary": "thompson", "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 63200, "user_id": "STEAM_0:0:2005", "name": "Polak",    "team": "allies", "class_id": 0, "weapon_primary": "garand",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 63200, "user_id": "STEAM_0:0:2006", "name": "ian",      "team": "allies", "class_id": 0, "weapon_primary": "garand",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 63200, "user_id": "STEAM_0:0:1001", "name": "Raphinha", "team": "axis",   "class_id": 0, "weapon_primary": "kar",      "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 63200, "user_id": "STEAM_0:0:1002", "name": "bud",      "team": "axis",   "class_id": 2, "weapon_primary": "mp40",     "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 63200, "user_id": "STEAM_0:0:1003", "name": "ORTIN",    "team": "axis",   "class_id": 0, "weapon_primary": "kar",      "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 63200, "user_id": "STEAM_0:0:1004", "name": "storm",    "team": "axis",   "class_id": 4, "weapon_primary": "scopedkar",     "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 63200, "user_id": "STEAM_0:0:1005", "name": "MaT*",     "team": "axis",   "class_id": 2, "weapon_primary": "mp40",     "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 63200, "user_id": "STEAM_0:0:1006", "name": "BitchX",   "team": "axis",   "class_id": 0, "weapon_primary": "kar",      "weapon_secondary": "luger" } },

    // Chat
    { "user_say": { "time": 67000, "user_id": "STEAM_0:0:2001", "team_only": false, "message": "our turn now" } },

    // Some half 2 action
    { "damage": { "time": 69900, "attacker_id": "STEAM_0:0:1001", "victim_id": "STEAM_0:0:2003", "damage": 100, "weapon": "kar", "hitplace": 2, "victim_health": 0 } },
    { "kill":   { "time": 70000, "killer_id": "STEAM_0:0:1001", "victim_id": "STEAM_0:0:2003", "weapon": "kar",    "kill_type": "normal", "kill_class": "gun", "headshot": false, "victim_prone": false, "killer_prone": false, "assist_ids": [] } },

    // Production: player_team_change to "spectator" (someone going to ref/spec mid-half).
    // Also shows team="spectator" is a real production value (CLAUDE.md schema says allies|axis only).
    { "player_team_change": { "time": 70500, "user_id": "STEAM_0:0:1003", "team": "spectator" } },

    // Assisted kill: bad softens Raphinha with 60, mogers headshots him.
    { "damage": { "time": 71500, "attacker_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1001", "damage": 60, "weapon": "thompson", "hitplace": 2, "victim_health": 40 } },
    { "damage": { "time": 71900, "attacker_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1001", "damage": 120, "weapon": "garand", "hitplace": 1, "victim_health": -80 } },
    { "kill":   { "time": 72000, "killer_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1001", "weapon": "garand", "kill_type": "normal", "kill_class": "gun", "headshot": true,  "victim_prone": false, "killer_prone": false, "assist_ids": ["STEAM_0:0:2004"] } },

    // Player rejoins from spec
    { "player_team_change": { "time": 72500, "user_id": "STEAM_0:0:1003", "team": "axis" } },

    // ── Half-2 capout: allies (mogers' team this half) sweep all 5 flags ──────
    // A full capout is the round-end trigger; the plugin emits a round_end
    // summary → the cumulative CAPOUT board (half-2 stats so far). Per-single-
    // flag-cap popups are gone; the flag feed still announces each cap.
    { "flag_captured": { "time": 73000, "flag_id": 0, "flag_name": "POINT_ANZIO_PLAZA",   "new_owner": "allies", "captor_ids": ["STEAM_0:0:2001"] } },
    { "flag_captured": { "time": 73050, "flag_id": 1, "flag_name": "POINT_ANZIO_STREET",  "new_owner": "allies", "captor_ids": ["STEAM_0:0:2004"] } },
    { "flag_captured": { "time": 73100, "flag_id": 2, "flag_name": "POINT_ANZIO_HILL",    "new_owner": "allies", "captor_ids": ["STEAM_0:0:2001", "STEAM_0:0:2002"] } },
    { "flag_captured": { "time": 73150, "flag_id": 3, "flag_name": "POINT_BRIDGE",        "new_owner": "allies", "captor_ids": ["STEAM_0:0:2005"] } },
    { "flag_captured": { "time": 73200, "flag_id": 4, "flag_name": "POINT_ANZIO_LAUNDRY", "new_owner": "allies", "captor_ids": ["STEAM_0:0:2002"] } },
    // Capout wins the round: allies 2 → 3.
    { "team_score":    { "time": 73250, "allies_score": 3, "axis_score": 1 } },
    { "player_stats_summary": { "time": 73300, "reason": "round_end", "capout_team": "allies", "capout_by": "omenator", "players": [
        { "user_id": "STEAM_0:0:2001", "name": "mogers",   "team": "allies", "kills": 1, "deaths": 0, "assists": 0, "damage": 120, "hs_kills": 1, "nade_kills": 0, "gun_kills": 1, "hits": 1, "hs_hits": 1, "obj_score": 10, "caps": 2, "best_streak": 1 },
        { "user_id": "STEAM_0:0:2002", "name": "omenator", "team": "allies", "kills": 0, "deaths": 0, "assists": 0, "damage": 0,   "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0, "obj_score": 10, "caps": 2, "best_streak": 0 },
        { "user_id": "STEAM_0:0:2003", "name": "E t",      "team": "allies", "kills": 0, "deaths": 1, "assists": 0, "damage": 0,   "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0, "obj_score": 0,  "caps": 0, "best_streak": 0 },
        { "user_id": "STEAM_0:0:2004", "name": "bad",      "team": "allies", "kills": 0, "deaths": 0, "assists": 1, "damage": 60,  "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 1, "hs_hits": 0, "obj_score": 5,  "caps": 1, "best_streak": 0 },
        { "user_id": "STEAM_0:0:2005", "name": "Polak",    "team": "allies", "kills": 0, "deaths": 0, "assists": 0, "damage": 0,   "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0, "obj_score": 5,  "caps": 1, "best_streak": 0 },
        { "user_id": "STEAM_0:0:2006", "name": "ian",      "team": "allies", "kills": 0, "deaths": 0, "assists": 0, "damage": 0,   "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0, "obj_score": 0,  "caps": 0, "best_streak": 0 },
        { "user_id": "STEAM_0:0:1001", "name": "Raphinha", "team": "axis",   "kills": 1, "deaths": 1, "assists": 0, "damage": 100, "hs_kills": 0, "nade_kills": 0, "gun_kills": 1, "hits": 1, "hs_hits": 0, "obj_score": 0,  "caps": 0, "best_streak": 1 },
        { "user_id": "STEAM_0:0:1002", "name": "bud",      "team": "axis",   "kills": 0, "deaths": 0, "assists": 0, "damage": 0,   "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0, "obj_score": 0,  "caps": 0, "best_streak": 0 },
        { "user_id": "STEAM_0:0:1003", "name": "ORTIN",    "team": "axis",   "kills": 0, "deaths": 0, "assists": 0, "damage": 0,   "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0, "obj_score": 0,  "caps": 0, "best_streak": 0 },
        { "user_id": "STEAM_0:0:1004", "name": "storm",    "team": "axis",   "kills": 0, "deaths": 0, "assists": 0, "damage": 0,   "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0, "obj_score": 0,  "caps": 0, "best_streak": 0 },
        { "user_id": "STEAM_0:0:1005", "name": "MaT*",     "team": "axis",   "kills": 0, "deaths": 0, "assists": 0, "damage": 0,   "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0, "obj_score": 0,  "caps": 0, "best_streak": 0 },
        { "user_id": "STEAM_0:0:1006", "name": "BitchX",   "team": "axis",   "kills": 0, "deaths": 0, "assists": 0, "damage": 0,   "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0, "obj_score": 0,  "caps": 0, "best_streak": 0 },
    ]}},

    { "time_sync": { "time": 76000, "timeleft": 1187 } },

    // match_end stats summary (NEW): emitted from the plugin's ktp_match_end
    // handler before the ktp_match_end event itself. Carries final-half stats;
    // the frontend sums it with the cached half-1 totals for the FINAL STATS
    // board. (mocker.ts POSTs the actual ktp_match_end after the sequence.)
    { "player_stats_summary": { "time": 77000, "reason": "match_end", "players": [
        { "user_id": "STEAM_0:0:2001", "name": "mogers",   "team": "allies", "kills": 1, "deaths": 0, "assists": 0, "damage": 120, "hs_kills": 1, "nade_kills": 0, "gun_kills": 1, "hits": 1, "hs_hits": 1, "obj_score": 10, "caps": 2, "best_streak": 1 },
        { "user_id": "STEAM_0:0:2002", "name": "omenator", "team": "allies", "kills": 0, "deaths": 0, "assists": 0, "damage": 0,   "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0, "obj_score": 10, "caps": 2, "best_streak": 0 },
        { "user_id": "STEAM_0:0:2003", "name": "E t",      "team": "allies", "kills": 0, "deaths": 1, "assists": 0, "damage": 0,   "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0, "obj_score": 0,  "caps": 0, "best_streak": 0 },
        { "user_id": "STEAM_0:0:2004", "name": "bad",      "team": "allies", "kills": 0, "deaths": 0, "assists": 1, "damage": 60,  "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 1, "hs_hits": 0, "obj_score": 5,  "caps": 1, "best_streak": 0 },
        { "user_id": "STEAM_0:0:2005", "name": "Polak",    "team": "allies", "kills": 0, "deaths": 0, "assists": 0, "damage": 0,   "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0, "obj_score": 5,  "caps": 1, "best_streak": 0 },
        { "user_id": "STEAM_0:0:2006", "name": "ian",      "team": "allies", "kills": 0, "deaths": 0, "assists": 0, "damage": 0,   "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0, "obj_score": 0,  "caps": 0, "best_streak": 0 },
        { "user_id": "STEAM_0:0:1001", "name": "Raphinha", "team": "axis",   "kills": 1, "deaths": 1, "assists": 0, "damage": 100, "hs_kills": 0, "nade_kills": 0, "gun_kills": 1, "hits": 1, "hs_hits": 0, "obj_score": 0,  "caps": 0, "best_streak": 1 },
        { "user_id": "STEAM_0:0:1002", "name": "bud",      "team": "axis",   "kills": 0, "deaths": 0, "assists": 0, "damage": 0,   "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0, "obj_score": 0,  "caps": 0, "best_streak": 0 },
        { "user_id": "STEAM_0:0:1003", "name": "ORTIN",    "team": "axis",   "kills": 0, "deaths": 0, "assists": 0, "damage": 0,   "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0, "obj_score": 0,  "caps": 0, "best_streak": 0 },
        { "user_id": "STEAM_0:0:1004", "name": "storm",    "team": "axis",   "kills": 0, "deaths": 0, "assists": 0, "damage": 0,   "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0, "obj_score": 0,  "caps": 0, "best_streak": 0 },
        { "user_id": "STEAM_0:0:1005", "name": "MaT*",     "team": "axis",   "kills": 0, "deaths": 0, "assists": 0, "damage": 0,   "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0, "obj_score": 0,  "caps": 0, "best_streak": 0 },
        { "user_id": "STEAM_0:0:1006", "name": "BitchX",   "team": "axis",   "kills": 0, "deaths": 0, "assists": 0, "damage": 0,   "hs_kills": 0, "nade_kills": 0, "gun_kills": 0, "hits": 0, "hs_hits": 0, "obj_score": 0,  "caps": 0, "best_streak": 0 },
    ]}},

]
