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
 *     All dod_anzio flags initialise as "neutral".
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

    // dod_anzio: 5 cap zones, all start neutral. flag_name = BSP entity string.
    { "flags_init": { "time": 1100, "flags": [
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

    // ian goes prone (shame!). Real plugin sets timestamp = get_systime()*1000 (wall clock).
    { "prone_change": { "time": 6000,  "user_id": "STEAM_0:0:2006", "state": "prone", "timestamp": 1741420806000 } },

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

    // Damage before kill
    { "damage": { "time": 8800, "attacker_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1003", "damage": 100, "weapon": "kar", "hitplace": 1, "victim_health": 0 } },
    { "kill":   { "time": 9000, "killer_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1003", "weapon": "kar",    "kill_type": "normal", "headshot": true,  "victim_prone": false, "killer_prone": false } },

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
    { "kill":   { "time": 10000, "killer_id": "STEAM_0:0:1001", "victim_id": "STEAM_0:0:2002", "weapon": "garand", "kill_type": "normal", "headshot": false, "victim_prone": false, "killer_prone": false } },

    // Cap interrupted — last axis leaves zone
    { "flag_zone_players": { "time": 10300, "zones": [
        { "flag_id": 0, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 1, "allies_count": 1, "axis_count": 0 },
        { "flag_id": 2, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 3, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 4, "allies_count": 0, "axis_count": 0 },
    ]}},
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
    { "kill":   { "time": 14000, "killer_id": "STEAM_0:0:1004", "victim_id": "STEAM_0:0:2006", "weapon": "spring", "kill_type": "normal", "headshot": true, "victim_prone": true, "killer_prone": false } },

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
    // Captors of the Street cap (1001, 1002) get +5 obj_score, mirroring the
    // dod_score_event score_delta the live plugin accumulates.
    { "player_score": { "time": 15200, "user_id": "STEAM_0:0:2001", "kills": 1, "deaths": 0, "score": 1, "obj_score": 0 } },
    { "player_score": { "time": 15200, "user_id": "STEAM_0:0:1001", "kills": 1, "deaths": 0, "score": 7, "obj_score": 5 } },
    { "player_score": { "time": 15200, "user_id": "STEAM_0:0:1002", "kills": 0, "deaths": 0, "score": 5, "obj_score": 5 } },
    { "player_score": { "time": 15200, "user_id": "STEAM_0:0:1004", "kills": 1, "deaths": 0, "score": 1, "obj_score": 0 } },
    { "player_score": { "time": 15200, "user_id": "STEAM_0:0:1003", "kills": 0, "deaths": 1, "score": 0, "obj_score": 0 } },
    { "player_score": { "time": 15200, "user_id": "STEAM_0:0:2002", "kills": 0, "deaths": 1, "score": 0, "obj_score": 0 } },
    { "player_score": { "time": 15200, "user_id": "STEAM_0:0:2006", "kills": 0, "deaths": 1, "score": 0, "obj_score": 0 } },

    // Tick-scoring re-broadcast — DoD periodically re-emits TeamScore for a
    // held flag with the same value, mostly as a sync nudge. The frontend
    // should be idempotent (same value → no visible change).
    { "team_score": { "time": 17000, "allies_score": 1, "axis_score": 0 } },

    // More fighting
    { "damage": { "time": 17800, "attacker_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1002", "damage": 35, "weapon": "mp44", "hitplace": 2, "victim_health": 65 } },
    { "damage": { "time": 17900, "attacker_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1002", "damage": 35, "weapon": "mp44", "hitplace": 3, "victim_health": 30 } },
    { "damage": { "time": 18000, "attacker_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1002", "damage": 35, "weapon": "mp44", "hitplace": 2, "victim_health": 0 } },
    { "kill":   { "time": 18000, "killer_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1002", "weapon": "mp44",   "kill_type": "normal", "headshot": false, "victim_prone": false, "killer_prone": false } },
    { "damage": { "time": 18900, "attacker_id": "STEAM_0:0:1006", "victim_id": "STEAM_0:0:2003", "damage": 100, "weapon": "garand", "hitplace": 1, "victim_health": 0 } },
    { "kill":   { "time": 19000, "killer_id": "STEAM_0:0:1006", "victim_id": "STEAM_0:0:2003", "weapon": "garand", "kill_type": "normal", "headshot": true,  "victim_prone": false, "killer_prone": false } },
    // mogers 2nd kill this round — streak
    { "damage": { "time": 19900, "attacker_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1005", "damage": 100, "weapon": "kar", "hitplace": 2, "victim_health": 0 } },
    { "kill":   { "time": 20000, "killer_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1005", "weapon": "kar",    "kill_type": "normal", "headshot": false, "victim_prone": false, "killer_prone": false } },

    // Teamkill
    { "kill":     { "time": 21000, "killer_id": "STEAM_0:0:2005", "victim_id": "STEAM_0:0:2004", "weapon": "kar",  "kill_type": "teamkill", "headshot": false, "victim_prone": false, "killer_prone": false } },
    { "user_say": { "time": 21500, "user_id": "STEAM_0:0:2004", "team_only": true, "message": "WTF POLAK" } },

    // Self-frag — BitchX cooks a grenade too long and blows himself up. DODX
    // attributes the nade (weapon "grenade", killer == victim), so the kill feed
    // shows skull + grenade icon, not a bare generic suicide.
    { "kill": { "time": 23000, "killer_id": "STEAM_0:0:1006", "victim_id": "STEAM_0:0:1006", "weapon": "grenade", "kill_type": "suicide", "headshot": false, "victim_prone": false, "killer_prone": false } },

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
    { "kill":   { "time": 42000, "killer_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1001", "weapon": "kar",  "kill_type": "normal", "headshot": true,  "victim_prone": false, "killer_prone": false } },
    { "damage": { "time": 42800, "attacker_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1006", "damage": 40, "weapon": "mp44", "hitplace": 4, "victim_health": 60 } },
    { "damage": { "time": 42900, "attacker_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1006", "damage": 40, "weapon": "mp44", "hitplace": 2, "victim_health": 20 } },
    { "damage": { "time": 43000, "attacker_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1006", "damage": 40, "weapon": "mp44", "hitplace": 3, "victim_health": 0 } },
    { "kill":   { "time": 43000, "killer_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1006", "weapon": "mp44", "kill_type": "normal", "headshot": false, "victim_prone": false, "killer_prone": true } },
    { "damage": { "time": 43900, "attacker_id": "STEAM_0:0:2002", "victim_id": "STEAM_0:0:1005", "damage": 30, "weapon": "mp40", "hitplace": 5, "victim_health": 70 } },
    { "damage": { "time": 44000, "attacker_id": "STEAM_0:0:2002", "victim_id": "STEAM_0:0:1005", "damage": 30, "weapon": "mp40", "hitplace": 2, "victim_health": 40 } },
    { "damage": { "time": 44000, "attacker_id": "STEAM_0:0:2002", "victim_id": "STEAM_0:0:1005", "damage": 40, "weapon": "mp40", "hitplace": 2, "victim_health": 0 } },
    { "kill":   { "time": 44000, "killer_id": "STEAM_0:0:2002", "victim_id": "STEAM_0:0:1005", "weapon": "mp40", "kill_type": "normal", "headshot": false, "victim_prone": false, "killer_prone": false } },

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

    // Captors of the Street recap (2001, 2004) get +5 obj_score from dod_score_event.
    { "player_score": { "time": 48200, "user_id": "STEAM_0:0:2001", "kills": 2, "deaths": 0, "score": 7, "obj_score": 5 } },
    { "player_score": { "time": 48200, "user_id": "STEAM_0:0:2004", "kills": 2, "deaths": 0, "score": 7, "obj_score": 5 } },

    { "time_sync": { "time": 56000, "timeleft": 1145 } },


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

    { "flags_init": { "time": 63100, "flags": [
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
    { "kill":   { "time": 70000, "killer_id": "STEAM_0:0:1001", "victim_id": "STEAM_0:0:2003", "weapon": "kar",    "kill_type": "normal", "headshot": false, "victim_prone": false, "killer_prone": false } },

    // Production: player_team_change to "spectator" (someone going to ref/spec mid-half).
    // Also shows team="spectator" is a real production value (CLAUDE.md schema says allies|axis only).
    { "player_team_change": { "time": 70500, "user_id": "STEAM_0:0:1003", "team": "spectator" } },

    { "damage": { "time": 71900, "attacker_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1001", "damage": 120, "weapon": "garand", "hitplace": 1, "victim_health": -20 } },
    { "kill":   { "time": 72000, "killer_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1001", "weapon": "garand", "kill_type": "normal", "headshot": true,  "victim_prone": false, "killer_prone": false } },

    // Player rejoins from spec
    { "player_team_change": { "time": 72500, "user_id": "STEAM_0:0:1003", "team": "axis" } },

    { "time_sync": { "time": 75000, "timeleft": 1187 } },

]
