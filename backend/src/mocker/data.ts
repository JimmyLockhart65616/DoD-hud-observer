/**
 * DoD HUD Observer — Mocker Event Sequence
 *
 * Simulates a realistic 6v6 DoD match (both halves).
 * Times are in milliseconds from mocker start.
 *
 * To run: npm run mocker
 * Frontend must connect to localhost:8000 (set REACT_APP_SOCKET_URL=http://localhost:8000)
 */

export default [

    // ══════════════════════════════════════════════════════════════════════════
    // ══  HALF 1  (Allies = team 1001-1006, Axis = team 2001-2006)  ═════════
    // ══════════════════════════════════════════════════════════════════════════

    { "half_start": { "time": 50, "half": 1, "timeleft": 1200 } },

    // ── Players connect ──────────────────────────────────────────────────────
    { "player_connect": { "time": 100,  "tick": 0.10, "user_id": "STEAM_0:0:1001", "name": "Raphinha",  "team": "allies" } },
    { "player_connect": { "time": 150,  "tick": 0.15, "user_id": "STEAM_0:0:1002", "name": "bud",       "team": "allies" } },
    { "player_connect": { "time": 200,  "tick": 0.20, "user_id": "STEAM_0:0:1003", "name": "ORTIN",     "team": "allies" } },
    { "player_connect": { "time": 250,  "tick": 0.25, "user_id": "STEAM_0:0:1004", "name": "storm",     "team": "allies" } },
    { "player_connect": { "time": 300,  "tick": 0.30, "user_id": "STEAM_0:0:1005", "name": "MaT*",      "team": "allies" } },
    { "player_connect": { "time": 350,  "tick": 0.35, "user_id": "STEAM_0:0:1006", "name": "BitchX",    "team": "allies" } },
    { "player_connect": { "time": 400,  "tick": 0.40, "user_id": "STEAM_0:0:2001", "name": "mogers",    "team": "axis" } },
    { "player_connect": { "time": 450,  "tick": 0.45, "user_id": "STEAM_0:0:2002", "name": "omenator",  "team": "axis" } },
    { "player_connect": { "time": 500,  "tick": 0.50, "user_id": "STEAM_0:0:2003", "name": "E t",       "team": "axis" } },
    { "player_connect": { "time": 550,  "tick": 0.55, "user_id": "STEAM_0:0:2004", "name": "bad",       "team": "axis" } },
    { "player_connect": { "time": 600,  "tick": 0.60, "user_id": "STEAM_0:0:2005", "name": "Polak",     "team": "axis" } },
    { "player_connect": { "time": 650,  "tick": 0.65, "user_id": "STEAM_0:0:2006", "name": "ian",       "team": "axis" } },

    // ── Round 1 ──────────────────────────────────────────────────────────────
    { "round_start_freeze": { "time": 1000, "tick": 1.00 } },

    { "flags_init": { "time": 1100, "tick": 1.10, "flags": [
        { "flag_id": 0, "flag_name": "Allied Base",   "owner": "allies" },
        { "flag_id": 1, "flag_name": "Church",        "owner": "neutral" },
        { "flag_id": 2, "flag_name": "Town Square",   "owner": "neutral" },
        { "flag_id": 3, "flag_name": "Depot",         "owner": "neutral" },
        { "flag_id": 4, "flag_name": "Axis Base",     "owner": "axis" },
    ]}},

    { "player_spawn": { "time": 1200, "tick": 1.20, "user_id": "STEAM_0:0:1001", "team": "allies", "class_id": 0, "weapon_primary": "garand",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 1200, "tick": 1.20, "user_id": "STEAM_0:0:1002", "team": "allies", "class_id": 2, "weapon_primary": "thompson", "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 1200, "tick": 1.20, "user_id": "STEAM_0:0:1003", "team": "allies", "class_id": 0, "weapon_primary": "garand",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 1200, "tick": 1.20, "user_id": "STEAM_0:0:1004", "team": "allies", "class_id": 4, "weapon_primary": "spring",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 1200, "tick": 1.20, "user_id": "STEAM_0:0:1005", "team": "allies", "class_id": 2, "weapon_primary": "thompson", "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 1200, "tick": 1.20, "user_id": "STEAM_0:0:1006", "team": "allies", "class_id": 0, "weapon_primary": "garand",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 1200, "tick": 1.20, "user_id": "STEAM_0:0:2001", "team": "axis",   "class_id": 0, "weapon_primary": "k98",      "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 1200, "tick": 1.20, "user_id": "STEAM_0:0:2002", "team": "axis",   "class_id": 2, "weapon_primary": "mp40",     "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 1200, "tick": 1.20, "user_id": "STEAM_0:0:2003", "team": "axis",   "class_id": 0, "weapon_primary": "k98",      "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 1200, "tick": 1.20, "user_id": "STEAM_0:0:2004", "team": "axis",   "class_id": 3, "weapon_primary": "mp44",     "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 1200, "tick": 1.20, "user_id": "STEAM_0:0:2005", "team": "axis",   "class_id": 0, "weapon_primary": "k98",      "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 1200, "tick": 1.20, "user_id": "STEAM_0:0:2006", "team": "axis",   "class_id": 6, "weapon_primary": "mg42",     "weapon_secondary": "luger" } },

    { "round_start": { "time": 4000, "tick": 4.00, "timeleft": 1197 } },
    { "caster_observed_player": { "time": 4500, "tick": 4.50, "user_id": "STEAM_0:0:1001" } },

    // ian goes prone (shame!)
    { "prone_change": { "time": 6000,  "tick": 6.00, "user_id": "STEAM_0:0:2006", "state": "prone", "timestamp": 1741420806000 } },

    // Chat: pre-round banter
    { "user_say": { "time": 6500, "tick": 6.50, "user_id": "STEAM_0:0:1001", "team_only": false, "message": "gl hf" } },
    { "user_say": { "time": 7000, "tick": 7.00, "user_id": "STEAM_0:0:2001", "team_only": false, "message": "hf" } },

    // Grenade thrown — Raphinha nades Church
    { "nade_throw": { "time": 7500, "tick": 7.50, "user_id": "STEAM_0:0:1001", "nade_type": "frag_allies" } },

    // Axis starts capping Church
    { "flag_cap_started": { "time": 8000, "tick": 8.00, "flag_id": 1, "flag_name": "Church", "capping_team": "axis", "captor_ids": ["STEAM_0:0:2001", "STEAM_0:0:2002"] } },

    // Axis players enter Church cap zone
    { "flag_zone_players": { "time": 7800, "tick": 7.80, "zones": [
        { "flag_id": 0, "allies_ids": [], "axis_ids": [] },
        { "flag_id": 1, "allies_ids": [], "axis_ids": ["STEAM_0:0:2001", "STEAM_0:0:2002"] },
        { "flag_id": 2, "allies_ids": [], "axis_ids": [] },
        { "flag_id": 3, "allies_ids": [], "axis_ids": [] },
        { "flag_id": 4, "allies_ids": [], "axis_ids": [] }
    ]}},

    // Cap progress ticking up
    { "flag_cap_progress": { "time": 8500, "tick": 8.50, "flag_id": 1, "progress": 10, "capping_team": "axis" } },

    // Damage before kills
    { "damage": { "time": 8800, "tick": 8.80, "attacker_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1003", "damage": 100, "weapon": "k98", "hitplace": 1, "victim_health": 0 } },
    { "kill": { "time": 9000,  "tick": 9.00,  "killer_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1003", "weapon": "k98",    "kill_type": "normal", "headshot": true,  "victim_prone": false, "killer_prone": false } },

    { "flag_cap_progress": { "time": 9200, "tick": 9.20, "flag_id": 1, "progress": 25, "capping_team": "axis" } },

    // Raphinha enters Church zone — cap contested!
    { "flag_zone_players": { "time": 9800, "tick": 9.80, "zones": [
        { "flag_id": 0, "allies_ids": [], "axis_ids": [] },
        { "flag_id": 1, "allies_ids": ["STEAM_0:0:1001"], "axis_ids": ["STEAM_0:0:2001", "STEAM_0:0:2002"] },
        { "flag_id": 2, "allies_ids": [], "axis_ids": [] },
        { "flag_id": 3, "allies_ids": [], "axis_ids": [] },
        { "flag_id": 4, "allies_ids": [], "axis_ids": [] }
    ]}},
    { "flag_cap_contested": { "time": 9900, "tick": 9.90, "flag_id": 1, "flag_name": "Church", "contesting_team": "allies", "contester_ids": ["STEAM_0:0:1001"] } },

    // Raphinha kills omenator on the point
    { "damage": { "time": 9950, "tick": 9.95, "attacker_id": "STEAM_0:0:1001", "victim_id": "STEAM_0:0:2002", "damage": 55, "weapon": "garand", "hitplace": 2, "victim_health": 45 } },
    { "damage": { "time": 10000, "tick": 10.00, "attacker_id": "STEAM_0:0:1001", "victim_id": "STEAM_0:0:2002", "damage": 55, "weapon": "garand", "hitplace": 3, "victim_health": 0 } },
    { "kill": { "time": 10000, "tick": 10.00, "killer_id": "STEAM_0:0:1001", "victim_id": "STEAM_0:0:2002", "weapon": "garand", "kill_type": "normal", "headshot": false, "victim_prone": false, "killer_prone": false } },

    // Cap interrupted — mogers leaves zone
    { "flag_zone_players": { "time": 10300, "tick": 10.30, "zones": [
        { "flag_id": 0, "allies_ids": [], "axis_ids": [] },
        { "flag_id": 1, "allies_ids": ["STEAM_0:0:1001"], "axis_ids": [] },
        { "flag_id": 2, "allies_ids": [], "axis_ids": [] },
        { "flag_id": 3, "allies_ids": [], "axis_ids": [] },
        { "flag_id": 4, "allies_ids": [], "axis_ids": [] }
    ]}},
    { "flag_cap_stopped": { "time": 10500, "tick": 10.50, "flag_id": 1, "flag_name": "Church", "capping_team": "axis" } },

    // Raphinha picks up the dead mp40
    { "weapon_pickup": { "time": 11000, "tick": 11.00, "user_id": "STEAM_0:0:1001", "weapon": "mp40" } },

    // Team chat
    { "user_say": { "time": 11500, "tick": 11.50, "user_id": "STEAM_0:0:1001", "team_only": true, "message": "picked up mp40, pushing church" } },

    // Allies push onto Church
    { "flag_zone_players": { "time": 12500, "tick": 12.50, "zones": [
        { "flag_id": 0, "allies_ids": [], "axis_ids": [] },
        { "flag_id": 1, "allies_ids": ["STEAM_0:0:1001", "STEAM_0:0:1002"], "axis_ids": [] },
        { "flag_id": 2, "allies_ids": [], "axis_ids": [] },
        { "flag_id": 3, "allies_ids": [], "axis_ids": [] },
        { "flag_id": 4, "allies_ids": [], "axis_ids": [] }
    ]}},
    { "flag_cap_started": { "time": 13000, "tick": 13.00, "flag_id": 1, "flag_name": "Church", "capping_team": "allies", "captor_ids": ["STEAM_0:0:1001", "STEAM_0:0:1002"] } },
    { "flag_cap_progress": { "time": 13200, "tick": 13.20, "flag_id": 1, "progress": 10, "capping_team": "allies" } },

    // ian still prone — killed while proning (shame)
    { "damage": { "time": 13900, "tick": 13.90, "attacker_id": "STEAM_0:0:1004", "victim_id": "STEAM_0:0:2006", "damage": 100, "weapon": "spring", "hitplace": 1, "victim_health": 0 } },
    { "kill": { "time": 14000, "tick": 14.00, "killer_id": "STEAM_0:0:1004", "victim_id": "STEAM_0:0:2006", "weapon": "spring", "kill_type": "normal", "headshot": true, "victim_prone": true, "killer_prone": false } },

    { "flag_cap_progress": { "time": 14200, "tick": 14.20, "flag_id": 1, "progress": 60, "capping_team": "allies" } },
    { "flag_cap_progress": { "time": 14700, "tick": 14.70, "flag_id": 1, "progress": 90, "capping_team": "allies" } },

    // Allies cap Church
    { "flag_captured": { "time": 15000, "tick": 15.00, "flag_id": 1, "flag_name": "Church", "new_owner": "allies", "captor_ids": ["STEAM_0:0:1001", "STEAM_0:0:1002"] } },
    { "flag_zone_players": { "time": 15100, "tick": 15.10, "zones": [
        { "flag_id": 0, "allies_ids": [], "axis_ids": [] },
        { "flag_id": 1, "allies_ids": [], "axis_ids": [] },
        { "flag_id": 2, "allies_ids": [], "axis_ids": [] },
        { "flag_id": 3, "allies_ids": [], "axis_ids": [] },
        { "flag_id": 4, "allies_ids": [], "axis_ids": [] }
    ]}},

    // Score updates
    { "player_score": { "time": 15100, "tick": 15.10, "user_id": "STEAM_0:0:2001", "kills": 1, "deaths": 0, "score": 1 } },
    { "player_score": { "time": 15100, "tick": 15.10, "user_id": "STEAM_0:0:1001", "kills": 1, "deaths": 0, "score": 2 } },
    { "player_score": { "time": 15100, "tick": 15.10, "user_id": "STEAM_0:0:1004", "kills": 1, "deaths": 0, "score": 1 } },
    { "player_score": { "time": 15100, "tick": 15.10, "user_id": "STEAM_0:0:1003", "kills": 0, "deaths": 1, "score": 0 } },
    { "player_score": { "time": 15100, "tick": 15.10, "user_id": "STEAM_0:0:2002", "kills": 0, "deaths": 1, "score": 0 } },
    { "player_score": { "time": 15100, "tick": 15.10, "user_id": "STEAM_0:0:2006", "kills": 0, "deaths": 1, "score": 0 } },

    // More fighting
    { "damage": { "time": 17800, "tick": 17.80, "attacker_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1002", "damage": 35, "weapon": "mp44", "hitplace": 2, "victim_health": 65 } },
    { "damage": { "time": 17900, "tick": 17.90, "attacker_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1002", "damage": 35, "weapon": "mp44", "hitplace": 3, "victim_health": 30 } },
    { "damage": { "time": 18000, "tick": 18.00, "attacker_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1002", "damage": 35, "weapon": "mp44", "hitplace": 2, "victim_health": 0 } },
    { "kill": { "time": 18000, "tick": 18.00, "killer_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1002", "weapon": "mp44",   "kill_type": "normal", "headshot": false, "victim_prone": false, "killer_prone": false } },
    { "nade_throw": { "time": 18500, "tick": 18.50, "user_id": "STEAM_0:0:2004", "nade_type": "frag_axis" } },
    { "damage": { "time": 18900, "tick": 18.90, "attacker_id": "STEAM_0:0:1006", "victim_id": "STEAM_0:0:2003", "damage": 100, "weapon": "garand", "hitplace": 1, "victim_health": 0 } },
    { "kill": { "time": 19000, "tick": 19.00, "killer_id": "STEAM_0:0:1006", "victim_id": "STEAM_0:0:2003", "weapon": "garand", "kill_type": "normal", "headshot": true,  "victim_prone": false, "killer_prone": false } },
    // mogers 2nd kill this round — streak!
    { "damage": { "time": 19900, "tick": 19.90, "attacker_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1005", "damage": 100, "weapon": "k98", "hitplace": 2, "victim_health": 0 } },
    { "kill": { "time": 20000, "tick": 20.00, "killer_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1005", "weapon": "k98",    "kill_type": "normal", "headshot": false, "victim_prone": false, "killer_prone": false } },

    // Teamkill
    { "kill": { "time": 21000, "tick": 21.00, "killer_id": "STEAM_0:0:2005", "victim_id": "STEAM_0:0:2004", "weapon": "k98",  "kill_type": "teamkill", "headshot": false, "victim_prone": false, "killer_prone": false } },
    { "user_say": { "time": 21500, "tick": 21.50, "user_id": "STEAM_0:0:2004", "team_only": true, "message": "WTF POLAK" } },

    // Time sync
    { "time_sync": { "time": 25000, "tick": 25.00, "timeleft": 1175 } },

    // Raphinha drops the mp40, back to garand
    { "weapon_drop": { "time": 26000, "tick": 26.00, "user_id": "STEAM_0:0:1001", "weapon": "mp40" } },
    { "weapon_pickup": { "time": 26100, "tick": 26.10, "user_id": "STEAM_0:0:1001", "weapon": "garand" } },

    // ── Player disconnect / reconnect ────────────────────────────────────────
    { "player_disconnect": { "time": 27000, "tick": 27.00, "user_id": "STEAM_0:0:2005" } },
    { "player_connect":    { "time": 29000, "tick": 29.00, "user_id": "STEAM_0:0:2005", "name": "Polak", "team": "axis" } },

    // Round 1 ends — Allies win
    { "round_end": { "time": 30000, "tick": 30.00, "winner": "allies", "end_type": "objectives", "allies_score": 1, "axis_score": 0 } },


    // ── Round 2 ──────────────────────────────────────────────────────────────
    { "round_start_freeze": { "time": 35000, "tick": 35.00 } },

    { "player_spawn": { "time": 35500, "tick": 35.50, "user_id": "STEAM_0:0:1001", "team": "allies", "class_id": 0, "weapon_primary": "garand",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 35500, "tick": 35.50, "user_id": "STEAM_0:0:1002", "team": "allies", "class_id": 2, "weapon_primary": "thompson", "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 35500, "tick": 35.50, "user_id": "STEAM_0:0:1003", "team": "allies", "class_id": 0, "weapon_primary": "garand",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 35500, "tick": 35.50, "user_id": "STEAM_0:0:1004", "team": "allies", "class_id": 4, "weapon_primary": "spring",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 35500, "tick": 35.50, "user_id": "STEAM_0:0:1005", "team": "allies", "class_id": 2, "weapon_primary": "thompson", "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 35500, "tick": 35.50, "user_id": "STEAM_0:0:1006", "team": "allies", "class_id": 0, "weapon_primary": "garand",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 35500, "tick": 35.50, "user_id": "STEAM_0:0:2001", "team": "axis",   "class_id": 0, "weapon_primary": "k98",      "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 35500, "tick": 35.50, "user_id": "STEAM_0:0:2002", "team": "axis",   "class_id": 2, "weapon_primary": "mp40",     "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 35500, "tick": 35.50, "user_id": "STEAM_0:0:2003", "team": "axis",   "class_id": 0, "weapon_primary": "k98",      "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 35500, "tick": 35.50, "user_id": "STEAM_0:0:2004", "team": "axis",   "class_id": 3, "weapon_primary": "mp44",     "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 35500, "tick": 35.50, "user_id": "STEAM_0:0:2005", "team": "axis",   "class_id": 0, "weapon_primary": "k98",      "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 35500, "tick": 35.50, "user_id": "STEAM_0:0:2006", "team": "axis",   "class_id": 6, "weapon_primary": "mg42",     "weapon_secondary": "luger" } },

    { "round_start": { "time": 38000, "tick": 38.00, "timeleft": 1163 } },
    { "team_score": { "time": 38100, "tick": 38.10, "allies_score": 1, "axis_score": 0 } },

    // Axis push hard — quick kills
    { "damage": { "time": 41900, "tick": 41.90, "attacker_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1001", "damage": 100, "weapon": "k98", "hitplace": 1, "victim_health": 0 } },
    { "kill": { "time": 42000, "tick": 42.00, "killer_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1001", "weapon": "k98",  "kill_type": "normal", "headshot": true,  "victim_prone": false, "killer_prone": false } },
    { "damage": { "time": 42800, "tick": 42.80, "attacker_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1006", "damage": 40, "weapon": "mp44", "hitplace": 4, "victim_health": 60 } },
    { "damage": { "time": 42900, "tick": 42.90, "attacker_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1006", "damage": 40, "weapon": "mp44", "hitplace": 2, "victim_health": 20 } },
    { "damage": { "time": 43000, "tick": 43.00, "attacker_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1006", "damage": 40, "weapon": "mp44", "hitplace": 3, "victim_health": 0 } },
    { "kill": { "time": 43000, "tick": 43.00, "killer_id": "STEAM_0:0:2004", "victim_id": "STEAM_0:0:1006", "weapon": "mp44", "kill_type": "normal", "headshot": false, "victim_prone": false, "killer_prone": true } },
    { "damage": { "time": 43900, "tick": 43.90, "attacker_id": "STEAM_0:0:2002", "victim_id": "STEAM_0:0:1005", "damage": 30, "weapon": "mp40", "hitplace": 5, "victim_health": 70 } },
    { "damage": { "time": 44000, "tick": 44.00, "attacker_id": "STEAM_0:0:2002", "victim_id": "STEAM_0:0:1005", "damage": 30, "weapon": "mp40", "hitplace": 2, "victim_health": 40 } },
    { "damage": { "time": 44000, "tick": 44.00, "attacker_id": "STEAM_0:0:2002", "victim_id": "STEAM_0:0:1005", "damage": 40, "weapon": "mp40", "hitplace": 2, "victim_health": 0 } },
    { "kill": { "time": 44000, "tick": 44.00, "killer_id": "STEAM_0:0:2002", "victim_id": "STEAM_0:0:1005", "weapon": "mp40", "kill_type": "normal", "headshot": false, "victim_prone": false, "killer_prone": false } },

    // Axis cap Church back — zone occupancy + progress
    { "flag_zone_players": { "time": 44500, "tick": 44.50, "zones": [
        { "flag_id": 1, "allies_ids": [], "axis_ids": ["STEAM_0:0:2001", "STEAM_0:0:2004"] }
    ]}},
    { "flag_cap_started": { "time": 45000, "tick": 45.00, "flag_id": 1, "flag_name": "Church", "capping_team": "axis", "captor_ids": ["STEAM_0:0:2001", "STEAM_0:0:2004"] } },
    { "flag_cap_progress": { "time": 45500, "tick": 45.50, "flag_id": 1, "progress": 15, "capping_team": "axis" } },
    { "flag_cap_progress": { "time": 46000, "tick": 46.00, "flag_id": 1, "progress": 35, "capping_team": "axis" } },
    { "flag_cap_progress": { "time": 46500, "tick": 46.50, "flag_id": 1, "progress": 55, "capping_team": "axis" } },
    { "flag_cap_progress": { "time": 47000, "tick": 47.00, "flag_id": 1, "progress": 75, "capping_team": "axis" } },
    { "flag_cap_progress": { "time": 47500, "tick": 47.50, "flag_id": 1, "progress": 95, "capping_team": "axis" } },
    { "flag_captured":    { "time": 48000, "tick": 48.00, "flag_id": 1, "flag_name": "Church", "new_owner": "axis", "captor_ids": ["STEAM_0:0:2001", "STEAM_0:0:2004"] } },

    // Round 2 ends — Axis win
    { "round_end": { "time": 55000, "tick": 55.00, "winner": "axis", "end_type": "objectives", "allies_score": 1, "axis_score": 1 } },

    { "time_sync": { "time": 56000, "tick": 56.00, "timeleft": 1145 } },


    // ══════════════════════════════════════════════════════════════════════════
    // ══  HALF 2  (teams swap sides — 1001-1006 now Axis, 2001-2006 now Allies)
    // ══════════════════════════════════════════════════════════════════════════

    { "half_start": { "time": 62000, "half": 2, "timeleft": 1200 } },

    // Team changes — each player moves to the opposite side
    { "player_team_change": { "time": 62100, "tick": 0.10, "user_id": "STEAM_0:0:1001", "team": "axis" } },
    { "player_team_change": { "time": 62100, "tick": 0.10, "user_id": "STEAM_0:0:1002", "team": "axis" } },
    { "player_team_change": { "time": 62100, "tick": 0.10, "user_id": "STEAM_0:0:1003", "team": "axis" } },
    { "player_team_change": { "time": 62100, "tick": 0.10, "user_id": "STEAM_0:0:1004", "team": "axis" } },
    { "player_team_change": { "time": 62100, "tick": 0.10, "user_id": "STEAM_0:0:1005", "team": "axis" } },
    { "player_team_change": { "time": 62100, "tick": 0.10, "user_id": "STEAM_0:0:1006", "team": "axis" } },
    { "player_team_change": { "time": 62100, "tick": 0.10, "user_id": "STEAM_0:0:2001", "team": "allies" } },
    { "player_team_change": { "time": 62100, "tick": 0.10, "user_id": "STEAM_0:0:2002", "team": "allies" } },
    { "player_team_change": { "time": 62100, "tick": 0.10, "user_id": "STEAM_0:0:2003", "team": "allies" } },
    { "player_team_change": { "time": 62100, "tick": 0.10, "user_id": "STEAM_0:0:2004", "team": "allies" } },
    { "player_team_change": { "time": 62100, "tick": 0.10, "user_id": "STEAM_0:0:2005", "team": "allies" } },
    { "player_team_change": { "time": 62100, "tick": 0.10, "user_id": "STEAM_0:0:2006", "team": "allies" } },

    // ── Half 2, Round 1 ──────────────────────────────────────────────────────
    { "round_start_freeze": { "time": 63000, "tick": 1.00 } },

    { "flags_init": { "time": 63100, "tick": 1.10, "flags": [
        { "flag_id": 0, "flag_name": "Allied Base",   "owner": "allies" },
        { "flag_id": 1, "flag_name": "Church",        "owner": "neutral" },
        { "flag_id": 2, "flag_name": "Town Square",   "owner": "neutral" },
        { "flag_id": 3, "flag_name": "Depot",         "owner": "neutral" },
        { "flag_id": 4, "flag_name": "Axis Base",     "owner": "axis" },
    ]}},

    // Spawns — note teams are swapped (1001-1006 now axis classes, 2001-2006 now allied classes)
    { "player_spawn": { "time": 63200, "tick": 1.20, "user_id": "STEAM_0:0:2001", "team": "allies", "class_id": 0, "weapon_primary": "garand",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 63200, "tick": 1.20, "user_id": "STEAM_0:0:2002", "team": "allies", "class_id": 2, "weapon_primary": "thompson", "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 63200, "tick": 1.20, "user_id": "STEAM_0:0:2003", "team": "allies", "class_id": 0, "weapon_primary": "garand",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 63200, "tick": 1.20, "user_id": "STEAM_0:0:2004", "team": "allies", "class_id": 2, "weapon_primary": "thompson", "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 63200, "tick": 1.20, "user_id": "STEAM_0:0:2005", "team": "allies", "class_id": 0, "weapon_primary": "garand",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 63200, "tick": 1.20, "user_id": "STEAM_0:0:2006", "team": "allies", "class_id": 0, "weapon_primary": "garand",   "weapon_secondary": "colt" } },
    { "player_spawn": { "time": 63200, "tick": 1.20, "user_id": "STEAM_0:0:1001", "team": "axis",   "class_id": 0, "weapon_primary": "k98",      "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 63200, "tick": 1.20, "user_id": "STEAM_0:0:1002", "team": "axis",   "class_id": 2, "weapon_primary": "mp40",     "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 63200, "tick": 1.20, "user_id": "STEAM_0:0:1003", "team": "axis",   "class_id": 0, "weapon_primary": "k98",      "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 63200, "tick": 1.20, "user_id": "STEAM_0:0:1004", "team": "axis",   "class_id": 4, "weapon_primary": "k98s",     "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 63200, "tick": 1.20, "user_id": "STEAM_0:0:1005", "team": "axis",   "class_id": 2, "weapon_primary": "mp40",     "weapon_secondary": "luger" } },
    { "player_spawn": { "time": 63200, "tick": 1.20, "user_id": "STEAM_0:0:1006", "team": "axis",   "class_id": 0, "weapon_primary": "k98",      "weapon_secondary": "luger" } },

    { "round_start": { "time": 66000, "tick": 4.00, "timeleft": 1197 } },

    // Chat
    { "user_say": { "time": 67000, "tick": 5.00, "user_id": "STEAM_0:0:2001", "team_only": false, "message": "our turn now" } },

    // Some half 2 action
    { "damage": { "time": 69900, "tick": 7.90, "attacker_id": "STEAM_0:0:1001", "victim_id": "STEAM_0:0:2003", "damage": 100, "weapon": "k98", "hitplace": 2, "victim_health": 0 } },
    { "kill": { "time": 70000, "tick": 8.00,  "killer_id": "STEAM_0:0:1001", "victim_id": "STEAM_0:0:2003", "weapon": "k98",    "kill_type": "normal", "headshot": false, "victim_prone": false, "killer_prone": false } },
    { "damage": { "time": 71900, "tick": 9.90, "attacker_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1003", "damage": 100, "weapon": "garand", "hitplace": 1, "victim_health": 0 } },
    { "kill": { "time": 72000, "tick": 10.00, "killer_id": "STEAM_0:0:2001", "victim_id": "STEAM_0:0:1003", "weapon": "garand", "kill_type": "normal", "headshot": true,  "victim_prone": false, "killer_prone": false } },

    { "time_sync": { "time": 75000, "tick": 13.00, "timeleft": 1187 } },

]
