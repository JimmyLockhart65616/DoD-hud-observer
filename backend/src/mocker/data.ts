/**
 * DoD HUD Observer — Mocker Event Sequence
 *
 * Simulates a realistic 6v6 DoD match (both halves).
 * Times are in milliseconds from mocker start.
 *
 * Event shapes mirror what KTPHudObserver.amxx actually emits in extension mode.
 * Verified against captured live plugin output (.local-refs/real-events.jsonl).
 *
 * Notable extension-mode constraints reflected here:
 *   - flag_zone_players carries integer counts (allies_count/axis_count), NOT id arrays.
 *     Per-player zone membership isn't readable in extension mode.
 *   - flag_cap_started.captor_ids is always []. Captor names only surface on
 *     flag_captured.captor_ids, populated by dod_score_event post-cap.
 *   - flag_cap_contested carries contester_count (int) + empty contester_ids: [].
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
    { "round_start_freeze": { "time": 1000 } },

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
    { "player_spawn": { "time": 1200, "user_id": "STEAM_0:0:2001", "name": "mogers",   "team": "axis",   "class_id": 0, "weapon_primary": "k98",      "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 1200, "user_id": "STEAM_0:0:2002", "name": "omenator", "team": "axis",   "class_id": 2, "weapon_primary": "mp40",     "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 1200, "user_id": "STEAM_0:0:2003", "name": "E t",      "team": "axis",   "class_id": 0, "weapon_primary": "k98",      "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 1200, "user_id": "STEAM_0:0:2004", "name": "bad",      "team": "axis",   "class_id": 3, "weapon_primary": "mp44",     "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 1200, "user_id": "STEAM_0:0:2005", "name": "Polak",    "team": "axis",   "class_id": 0, "weapon_primary": "k98",      "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 1200, "user_id": "STEAM_0:0:2006", "name": "ian",      "team": "axis",   "class_id": 6, "weapon_primary": "mg42",     "weapon_secondary": "luger" } },

    { "round_start": { "time": 4000, "timeleft": 1197 } },
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

    // Grenade thrown — Raphinha nades the Street
    { "nade_throw": { "time": 7500, "user_id": "STEAM_0:0:1001", "nade_type": "frag_allies" } },

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
    { "damage": { "time": 8800, "attacker_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1003", "damage": 100, "weapon": "k98", "hitplace": 1, "victim_health": 0 } },
    { "kill":   { "time": 9000, "killer_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1003", "weapon": "k98",    "kill_type": "normal", "headshot": true,  "victim_prone": false, "killer_prone": false } },

    { "flag_cap_progress": { "time": 9200, "flag_id": 1, "progress": 25, "capping_team": "axis" } },

    // Raphinha enters Anzio Street zone — cap contested.
    { "flag_zone_players": { "time": 9800, "zones": [
        { "flag_id": 0, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 1, "allies_count": 1, "axis_count": 2 },
        { "flag_id": 2, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 3, "allies_count": 0, "axis_count": 0 },
        { "flag_id": 4, "allies_count": 0, "axis_count": 0 },
    ]}},
    // contester_count is the count of opposing-team bodies in the zone; ids stay [].
    { "flag_cap_contested": { "time": 9900, "flag_id": 1, "flag_name": "POINT_ANZIO_STREET", "contesting_team": "allies", "contester_count": 1, "contester_ids": [] } },

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

    // Raphinha picks up the dead mp40
    { "weapon_pickup": { "time": 11000, "user_id": "STEAM_0:0:1001", "weapon": "mp40" } },

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
    { "player_score": { "time": 15200, "user_id": "STEAM_0:0:2001", "kills": 1, "deaths": 0, "score": 1 } },
    { "player_score": { "time": 15200, "user_id": "STEAM_0:0:1001", "kills": 1, "deaths": 0, "score": 2 } },
    { "player_score": { "time": 15200, "user_id": "STEAM_0:0:1004", "kills": 1, "deaths": 0, "score": 1 } },
    { "player_score": { "time": 15200, "user_id": "STEAM_0:0:1003", "kills": 0, "deaths": 1, "score": 0 } },
    { "player_score": { "time": 15200, "user_id": "STEAM_0:0:2002", "kills": 0, "deaths": 1, "score": 0 } },
    { "player_score": { "time": 15200, "user_id": "STEAM_0:0:2006", "kills": 0, "deaths": 1, "score": 0 } },

    // More fighting
    { "damage": { "time": 17800, "attacker_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1002", "damage": 35, "weapon": "mp44", "hitplace": 2, "victim_health": 65 } },
    { "damage": { "time": 17900, "attacker_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1002", "damage": 35, "weapon": "mp44", "hitplace": 3, "victim_health": 30 } },
    { "damage": { "time": 18000, "attacker_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1002", "damage": 35, "weapon": "mp44", "hitplace": 2, "victim_health": 0 } },
    { "kill":   { "time": 18000, "killer_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1002", "weapon": "mp44",   "kill_type": "normal", "headshot": false, "victim_prone": false, "killer_prone": false } },
    { "nade_throw": { "time": 18500, "user_id": "STEAM_0:0:2004", "nade_type": "frag_axis" } },
    { "damage": { "time": 18900, "attacker_id": "STEAM_0:0:1006", "victim_id": "STEAM_0:0:2003", "damage": 100, "weapon": "garand", "hitplace": 1, "victim_health": 0 } },
    { "kill":   { "time": 19000, "killer_id": "STEAM_0:0:1006", "victim_id": "STEAM_0:0:2003", "weapon": "garand", "kill_type": "normal", "headshot": true,  "victim_prone": false, "killer_prone": false } },
    // mogers 2nd kill this round — streak
    { "damage": { "time": 19900, "attacker_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1005", "damage": 100, "weapon": "k98", "hitplace": 2, "victim_health": 0 } },
    { "kill":   { "time": 20000, "killer_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1005", "weapon": "k98",    "kill_type": "normal", "headshot": false, "victim_prone": false, "killer_prone": false } },

    // Teamkill
    { "kill":     { "time": 21000, "killer_id": "STEAM_0:0:2005", "victim_id": "STEAM_0:0:2004", "weapon": "k98",  "kill_type": "teamkill", "headshot": false, "victim_prone": false, "killer_prone": false } },
    { "user_say": { "time": 21500, "user_id": "STEAM_0:0:2004", "team_only": true, "message": "WTF POLAK" } },

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

    // Raphinha drops the mp40, back to garand
    { "weapon_drop":   { "time": 26000, "user_id": "STEAM_0:0:1001", "weapon": "mp40" } },
    { "weapon_pickup": { "time": 26100, "user_id": "STEAM_0:0:1001", "weapon": "garand" } },

    // ── Player disconnect / reconnect ────────────────────────────────────────
    { "player_disconnect": { "time": 27000, "user_id": "STEAM_0:0:2005" } },
    { "player_connect":    { "time": 29000, "user_id": "STEAM_0:0:2005", "name": "Polak", "team": "axis" } },

    // Round 1 ends — Allies win
    { "round_end": { "time": 30000, "winner": "allies", "end_type": "objectives", "allies_score": 1, "axis_score": 0 } },


    // ── Round 2 ──────────────────────────────────────────────────────────────
    { "round_start_freeze": { "time": 35000 } },

    { "player_spawn": { "time": 35500, "user_id": "STEAM_0:0:1001", "name": "Raphinha", "team": "allies", "class_id": 0, "weapon_primary": "garand",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 35500, "user_id": "STEAM_0:0:1002", "name": "bud",      "team": "allies", "class_id": 2, "weapon_primary": "thompson", "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 35500, "user_id": "STEAM_0:0:1003", "name": "ORTIN",    "team": "allies", "class_id": 0, "weapon_primary": "garand",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 35500, "user_id": "STEAM_0:0:1004", "name": "storm",    "team": "allies", "class_id": 4, "weapon_primary": "spring",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 35500, "user_id": "STEAM_0:0:1005", "name": "MaT*",     "team": "allies", "class_id": 2, "weapon_primary": "thompson", "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 35500, "user_id": "STEAM_0:0:1006", "name": "BitchX",   "team": "allies", "class_id": 0, "weapon_primary": "garand",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 35500, "user_id": "STEAM_0:0:2001", "name": "mogers",   "team": "axis",   "class_id": 0, "weapon_primary": "k98",      "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 35500, "user_id": "STEAM_0:0:2002", "name": "omenator", "team": "axis",   "class_id": 2, "weapon_primary": "mp40",     "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 35500, "user_id": "STEAM_0:0:2003", "name": "E t",      "team": "axis",   "class_id": 0, "weapon_primary": "k98",      "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 35500, "user_id": "STEAM_0:0:2004", "name": "bad",      "team": "axis",   "class_id": 3, "weapon_primary": "mp44",     "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 35500, "user_id": "STEAM_0:0:2005", "name": "Polak",    "team": "axis",   "class_id": 0, "weapon_primary": "k98",      "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 35500, "user_id": "STEAM_0:0:2006", "name": "ian",      "team": "axis",   "class_id": 6, "weapon_primary": "mg42",     "weapon_secondary": "luger" } },

    { "round_start": { "time": 38000, "timeleft": 1163 } },
    { "team_score":  { "time": 38100, "allies_score": 1, "axis_score": 0 } },

    // Axis push hard — quick kills
    { "damage": { "time": 41900, "attacker_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1001", "damage": 100, "weapon": "k98", "hitplace": 1, "victim_health": 0 } },
    { "kill":   { "time": 42000, "killer_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1001", "weapon": "k98",  "kill_type": "normal", "headshot": true,  "victim_prone": false, "killer_prone": false } },
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
    { "team_score":        { "time": 48000, "allies_score": 1, "axis_score": 1 } },

    // Round 2 ends — Axis win
    { "round_end": { "time": 55000, "winner": "axis", "end_type": "objectives", "allies_score": 1, "axis_score": 1 } },

    { "time_sync": { "time": 56000, "timeleft": 1145 } },


    // ══════════════════════════════════════════════════════════════════════════
    // ══  HALF 2  (teams swap sides — 1001-1006 now Axis, 2001-2006 now Allies)
    // ══════════════════════════════════════════════════════════════════════════

    { "half_start": { "time": 62000, "half": 2, "timeleft": 1200 } },

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
    { "round_start_freeze": { "time": 63000 } },

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
    { "player_spawn": { "time": 63200, "user_id": "STEAM_0:0:1001", "name": "Raphinha", "team": "axis",   "class_id": 0, "weapon_primary": "k98",      "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 63200, "user_id": "STEAM_0:0:1002", "name": "bud",      "team": "axis",   "class_id": 2, "weapon_primary": "mp40",     "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 63200, "user_id": "STEAM_0:0:1003", "name": "ORTIN",    "team": "axis",   "class_id": 0, "weapon_primary": "k98",      "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 63200, "user_id": "STEAM_0:0:1004", "name": "storm",    "team": "axis",   "class_id": 4, "weapon_primary": "k98s",     "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 63200, "user_id": "STEAM_0:0:1005", "name": "MaT*",     "team": "axis",   "class_id": 2, "weapon_primary": "mp40",     "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 63200, "user_id": "STEAM_0:0:1006", "name": "BitchX",   "team": "axis",   "class_id": 0, "weapon_primary": "k98",      "weapon_secondary": "luger" } },

    { "round_start": { "time": 66000, "timeleft": 1197 } },

    // Chat
    { "user_say": { "time": 67000, "user_id": "STEAM_0:0:2001", "team_only": false, "message": "our turn now" } },

    // Some half 2 action
    { "damage": { "time": 69900, "attacker_id": "STEAM_0:0:1001", "victim_id": "STEAM_0:0:2003", "damage": 100, "weapon": "k98", "hitplace": 2, "victim_health": 0 } },
    { "kill":   { "time": 70000, "killer_id": "STEAM_0:0:1001", "victim_id": "STEAM_0:0:2003", "weapon": "k98",    "kill_type": "normal", "headshot": false, "victim_prone": false, "killer_prone": false } },
    { "damage": { "time": 71900, "attacker_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1003", "damage": 100, "weapon": "garand", "hitplace": 1, "victim_health": 0 } },
    { "kill":   { "time": 72000, "killer_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1003", "weapon": "garand", "kill_type": "normal", "headshot": true,  "victim_prone": false, "killer_prone": false } },

    { "time_sync": { "time": 75000, "timeleft": 1187 } },

]
