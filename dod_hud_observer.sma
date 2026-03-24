/**
 * dod_hud_observer.sma
 *
 * Day of Defeat 1.3 HUD Observer Plugin
 * Authored by Jimmy Lockhart aka cadaver https://github.com/JimmyLockhart65616
 * Sends real-time game events as JSON over TCP to the hud-observer Node.js backend.
 *
 * Install: place compiled .amxx in addons/amxmodx/plugins/
 *          add "dod_hud_observer.amxx" to addons/amxmodx/configs/plugins.ini
 * Requires: Metamod, AMX Mod X, dodfun_amxx, dodx_amxx, socket_amxx
 *
 * CVARs (set in server.cfg or amxmodx/configs/amxx.cfg):
 *   dod_hud_host   "127.0.0.1"   IP of the hud-observer backend
 *   dod_hud_port   "9000"        TCP port of the hud-observer backend
 *   dod_hud_token  ""            Auth token (must match backend config.json)
 */

#include <amxmodx>
#include <amxmisc>
#include <dodfun>
#include <dodx>
#include <fakemeta>
#include <sockets>

// ─── Constants ───────────────────────────────────────────────────────────────

#define PLUGIN  "DoD HUD Observer"
#define VERSION "1.0.0"
#define AUTHOR  "hud-observer"

#define MAX_PLAYERS     32
#define MAX_FLAGS       32
#define RECONNECT_DELAY  5.0
#define TIME_SYNC_DELAY 30.0
#define BUFFER_SIZE     2048

// Team IDs (dodconst.inc: ALLIES=1, AXIS=2)
#define TEAM_UNASSIGNED 0
#define TEAM_ALLIES     1
#define TEAM_AXIS       2

// Prone state labels
#define PRONE_STANDING  0
#define PRONE_PRONE     1
#define PRONE_DEPLOYED  2

// ─── Globals ─────────────────────────────────────────────────────────────────

new g_socket         = -1;
new bool:g_connected = false;
new bool:g_authed    = false;

new g_cvar_host[64];
new g_cvar_port;
new g_cvar_token[64];

new g_player_team[MAX_PLAYERS + 1];
new g_player_prone[MAX_PLAYERS + 1];
new g_player_alive[MAX_PLAYERS + 1];

// -1 = not yet seen from InitObj
new g_flag_owner[MAX_FLAGS];
new g_flag_count;

new g_half = 1;

// ─── Cap Zone Tracking ──────────────────────────────────────────────────────
#define CAP_ZONE_POLL_INTERVAL 0.5

new g_capzone_ent[MAX_FLAGS];
new Float:g_capzone_mins[MAX_FLAGS][3];
new Float:g_capzone_maxs[MAX_FLAGS][3];
new g_capzone_count;

// Previous poll state for diffing (bitmask of player slots per team per zone)
new g_zone_prev_allies[MAX_FLAGS];
new g_zone_prev_axis[MAX_FLAGS];

// Cap progress tracking
new Float:g_cap_start_time[MAX_FLAGS];
new Float:g_cap_total_time[MAX_FLAGS];
new g_cap_capping_team[MAX_FLAGS];    // 0=none, TEAM_ALLIES, TEAM_AXIS
new bool:g_cap_contested[MAX_FLAGS];

// Fallback cap time if entity keyvalue unreadable
new Float:g_cvar_cap_time = 20.0;

// ─── Plugin Init ─────────────────────────────────────────────────────────────

public plugin_init() {
    register_plugin(PLUGIN, VERSION, AUTHOR);

    register_cvar("dod_hud_host",     "127.0.0.1", FCVAR_SERVER);
    register_cvar("dod_hud_port",     "9000",       FCVAR_SERVER);
    register_cvar("dod_hud_token",    "",           FCVAR_PROTECTED);
    register_cvar("dod_hud_cap_time", "20.0",       FCVAR_SERVER);

    register_logevent("ev_round_start", 2, "1=World triggered", "2=Round_Start");
    register_logevent("ev_round_end",   2, "1=World triggered", "2=Round_End");

    // DeathMsg and TeamScore are global (a), ScoreShort is per-player but sent to all (a)
    register_event("DeathMsg",   "ev_kill",         "a");
    register_event("TeamScore",  "ev_team_score",   "a");
    register_event("ScoreShort", "ev_player_score", "a");
    register_event("InitObj",    "ev_flags_update", "a");

    register_clcmd("say",      "ev_say");
    register_clcmd("say_team", "ev_say_team");

    register_concmd("amx_dod_half",    "cmd_half",    ADMIN_RCON, "<1|2> — signal half change");
    register_concmd("amx_dod_observe", "cmd_observe", ADMIN_RCON, "<steamid> — caster observe");

    set_task(RECONNECT_DELAY,       "task_connect",         _, _, _, "b");
    set_task(0.25,                  "task_poll_prone",      _, _, _, "b");
    set_task(TIME_SYNC_DELAY,       "task_time_sync",       _, _, _, "b");
    set_task(CAP_ZONE_POLL_INTERVAL, "task_poll_cap_zones", _, _, _, "b");
}

public plugin_cfg() {
    for (new i = 0; i < MAX_FLAGS; i++) {
        g_flag_owner[i] = -1;
        g_cap_capping_team[i] = 0;
        g_cap_contested[i] = false;
    }
    g_capzone_count = 0;
    // CVARs are read in task_connect() to ensure amxx.cfg has loaded
}

public plugin_end() {
    if (g_socket >= 0) socket_close(g_socket);
}

// ─── Connection Management ───────────────────────────────────────────────────

public task_connect() {
    if (g_connected) return;

    // Re-read CVARs each attempt (amxx.cfg may load after plugin_cfg)
    get_cvar_string("dod_hud_host",  g_cvar_host,  charsmax(g_cvar_host));
    g_cvar_port = get_cvar_num("dod_hud_port");
    get_cvar_string("dod_hud_token", g_cvar_token, charsmax(g_cvar_token));

    server_print("[HUD] Connecting to %s:%d ...", g_cvar_host, g_cvar_port);

    new err;
    g_socket = socket_open(g_cvar_host, g_cvar_port, SOCKET_TCP, err);

    if (g_socket < 0 || err) {
        server_print("[HUD] socket_open failed: socket=%d err=%d", g_socket, err);
        g_connected = false;
        g_authed    = false;
        return;
    }

    server_print("[HUD] Connected! socket=%d", g_socket);
    g_connected = true;

    new auth_msg[128];
    format(auth_msg, charsmax(auth_msg), "Bearer %s^n", g_cvar_token);
    socket_send(g_socket, auth_msg, strlen(auth_msg));
    g_authed = true;

    do_flags_init();
    do_find_cap_zones();
    do_roster_dump();
}

// Send player_connect + player_spawn for every player currently on the server.
// Called on (re)connect so the HUD gets a full snapshot even if it missed the
// original client_authorized / dod_client_spawn events.
stock do_roster_dump() {
    new maxp = get_maxplayers();
    for (new id = 1; id <= maxp; id++) {
        if (!is_user_connected(id)) continue;
        if (is_user_hltv(id)) continue;

        new steamid[32], name[64], name_esc[128], team_str[16];
        get_steamid(id, steamid, charsmax(steamid));
        get_user_name(id, name, charsmax(name));
        escape_json(name, name_esc, charsmax(name_esc));

        new team = get_user_team(id);
        get_team_str(team, team_str, charsmax(team_str));

        g_player_team[id] = team;

        // player_connect with the CURRENT team (not unassigned)
        new json[256];
        format(json, charsmax(json),
            "{^"event^":^"player_connect^",^"user_id^":^"%s^",^"name^":^"%s^",^"team^":^"%s^"}",
            steamid, name_esc, team_str);
        do_send_json(json);

        // If alive and on a real team, also send spawn state
        if (is_user_alive(id) && (team == TEAM_ALLIES || team == TEAM_AXIS)) {
            new class_id = dod_get_user_class(id);
            new wpn_primary[32], wpn_secondary[32];
            get_wpn_name_for_slot(id, DODWT_PRIMARY,   wpn_primary,   charsmax(wpn_primary));
            get_wpn_name_for_slot(id, DODWT_SECONDARY, wpn_secondary, charsmax(wpn_secondary));

            g_player_prone[id] = PRONE_STANDING;
            g_player_alive[id] = 1;

            format(json, charsmax(json),
                "{^"event^":^"player_spawn^",^"user_id^":^"%s^",^"team^":^"%s^",^"class_id^":%d,^"weapon_primary^":^"%s^",^"weapon_secondary^":^"%s^"}",
                steamid, team_str, class_id, wpn_primary, wpn_secondary);
            do_send_json(json);
        }
    }
    server_print("[HUD] Roster dump: sent %d players", maxp);
}

stock do_disconnect() {
    if (g_socket >= 0) {
        socket_close(g_socket);
        g_socket = -1;
    }
    g_connected = false;
    g_authed    = false;
}

stock do_send_json(const json[]) {
    if (!g_connected || !g_authed || g_socket < 0) return;

    // Inject "tick" (game time in seconds since map load) into every event.
    // json always starts with '{', so json[1] skips it; we prepend our own '{' with tick.
    static msg[BUFFER_SIZE];
    format(msg, charsmax(msg), "{^"tick^":%.2f,%s^n", get_gametime(), json[1]);

    if (socket_send(g_socket, msg, strlen(msg)) < 0) {
        do_disconnect();
    }
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
        // Bots all return "BOT" from get_user_authid — use player slot for uniqueness
        formatex(out, len, "BOT_%d", id);
    } else {
        get_user_authid(id, out, len);
    }
}

stock get_unix_ms(out[], len) {
    // AMXX has no ms precision; multiply seconds by 1000
    format(out, len, "%d000", get_systime());
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
    new steamid[32], prone_str[16], ts[24];
    get_steamid(id, steamid, charsmax(steamid));
    get_prone_str(prone_state, prone_str, charsmax(prone_str));
    get_unix_ms(ts, charsmax(ts));

    new json[256];
    format(json, charsmax(json),
        "{^"event^":^"prone_change^",^"user_id^":^"%s^",^"state^":^"%s^",^"timestamp^":%s}",
        steamid, prone_str, ts);
    do_send_json(json);
}

// ─── Round Events ────────────────────────────────────────────────────────────

public ev_round_start() {
    new timeleft = get_timeleft();

    new json[128];
    format(json, charsmax(json), "{^"event^":^"round_start^",^"timeleft^":%d}", timeleft);
    do_send_json(json);

    do_flags_init();
    do_find_cap_zones();
}

public ev_round_end() {
    new allies = dod_get_team_score(TEAM_ALLIES);
    new axis   = dod_get_team_score(TEAM_AXIS);

    new winner[16];
    if (allies > axis)      copy(winner, charsmax(winner), "allies");
    else if (axis > allies) copy(winner, charsmax(winner), "axis");
    else                    copy(winner, charsmax(winner), "draw");

    new json[256];
    format(json, charsmax(json),
        "{^"event^":^"round_end^",^"winner^":^"%s^",^"end_type^":^"objectives^",^"allies_score^":%d,^"axis_score^":%d}",
        winner, allies, axis);
    do_send_json(json);
}

public cmd_half(id, level, cid) {
    if (!cmd_access(id, ADMIN_RCON, cid, 2)) return PLUGIN_HANDLED;

    new arg[4];
    read_argv(1, arg, charsmax(arg));
    g_half = str_to_num(arg);

    new timeleft = get_timeleft();

    new json[128];
    format(json, charsmax(json), "{^"event^":^"half_start^",^"half^":%d,^"timeleft^":%d}", g_half, timeleft);
    do_send_json(json);

    return PLUGIN_HANDLED;
}

// ─── Player Events ───────────────────────────────────────────────────────────

public client_authorized(id) {
    if (is_user_hltv(id)) return;

    new steamid[32], name[64], name_esc[128], team_str[16];

    get_steamid(id, steamid, charsmax(steamid));
    get_user_name(id, name, charsmax(name));
    escape_json(name, name_esc, charsmax(name_esc));

    // Player isn't fully in-game yet at client_authorized — get_user_team
    // would cause DODX "Invalid player" error.  They always start unassigned.
    get_team_str(TEAM_UNASSIGNED, team_str, charsmax(team_str));

    g_player_team[id]  = TEAM_UNASSIGNED;
    g_player_prone[id] = PRONE_STANDING;
    g_player_alive[id] = 0;

    new json[256];
    format(json, charsmax(json),
        "{^"event^":^"player_connect^",^"user_id^":^"%s^",^"name^":^"%s^",^"team^":^"%s^"}",
        steamid, name_esc, team_str);
    do_send_json(json);
}

public client_disconnect(id) {
    if (is_user_hltv(id)) return;

    new steamid[32];
    get_steamid(id, steamid, charsmax(steamid));

    new json[128];
    format(json, charsmax(json),
        "{^"event^":^"player_disconnect^",^"user_id^":^"%s^"}", steamid);
    do_send_json(json);

    g_player_team[id]  = 0;
    g_player_prone[id] = PRONE_STANDING;
    g_player_alive[id] = 0;
}

// dod_client_spawn is the correct dodx forward for spawn detection
public dod_client_spawn(id) {
    if (is_user_hltv(id)) return;
    if (!is_user_alive(id)) return;

    new steamid[32], team_str[16], wpn_primary[32], wpn_secondary[32];
    get_steamid(id, steamid, charsmax(steamid));

    new team     = get_user_team(id);
    new class_id = dod_get_user_class(id);
    get_team_str(team, team_str, charsmax(team_str));

    get_wpn_name_for_slot(id, DODWT_PRIMARY,   wpn_primary,   charsmax(wpn_primary));
    get_wpn_name_for_slot(id, DODWT_SECONDARY, wpn_secondary, charsmax(wpn_secondary));

    g_player_team[id]  = team;
    g_player_prone[id] = PRONE_STANDING;
    g_player_alive[id] = 1;

    new json[256];
    format(json, charsmax(json),
        "{^"event^":^"player_spawn^",^"user_id^":^"%s^",^"team^":^"%s^",^"class_id^":%d,^"weapon_primary^":^"%s^",^"weapon_secondary^":^"%s^"}",
        steamid, team_str, class_id, wpn_primary, wpn_secondary);
    do_send_json(json);

    // Reset prone timer on respawn
    do_prone_change(id, PRONE_STANDING);
}

// client_damage is a DODX forward — fires on every hit before death
public client_damage(attacker, victim, damage, wpnindex, hitplace, TK) {
    if (!g_authed) return;
    if (attacker < 1 || attacker > MAX_PLAYERS) return;
    if (victim < 1 || victim > MAX_PLAYERS) return;

    new attacker_steam[35], victim_steam[35], weapon[32];
    get_steamid(attacker, attacker_steam, charsmax(attacker_steam));
    get_steamid(victim, victim_steam, charsmax(victim_steam));
    xmod_get_wpnlogname(wpnindex, weapon, charsmax(weapon));

    new victim_health = get_user_health(victim);

    new json[512];
    format(json, charsmax(json),
        "{^"event^":^"damage^",^"attacker_id^":^"%s^",^"victim_id^":^"%s^",^"damage^":%d,^"weapon^":^"%s^",^"hitplace^":%d,^"victim_health^":%d}",
        attacker_steam, victim_steam, damage, weapon, hitplace, victim_health);
    do_send_json(json);
}

// DeathMsg: read_data(1)=killer, read_data(2)=victim, read_data(3)=headshot, read_data(4)=weapon string
public ev_kill() {
    new killer_id = read_data(1);
    new victim_id = read_data(2);
    new headshot  = read_data(3);
    new weapon[32];
    read_data(4, weapon, charsmax(weapon));

    // World kills (falling, team-switch) send killer_id=0 — treat as suicide
    if (killer_id < 1 || killer_id > MAX_PLAYERS) killer_id = victim_id;
    if (victim_id < 1 || victim_id > MAX_PLAYERS) return;

    new killer_steamid[32], victim_steamid[32];
    get_steamid(killer_id, killer_steamid, charsmax(killer_steamid));
    get_steamid(victim_id, victim_steamid, charsmax(victim_steamid));

    new kill_type[16];
    if (killer_id == victim_id) {
        copy(kill_type, charsmax(kill_type), "suicide");
    } else if (get_user_team(killer_id) == get_user_team(victim_id)) {
        copy(kill_type, charsmax(kill_type), "teamkill");
    } else {
        copy(kill_type, charsmax(kill_type), "normal");
    }

    new victim_prone = (g_player_prone[victim_id] != PRONE_STANDING) ? 1 : 0;
    new killer_prone = (g_player_prone[killer_id] != PRONE_STANDING) ? 1 : 0;

    g_player_alive[victim_id] = 0;
    g_player_prone[victim_id] = PRONE_STANDING;

    new json[512];
    format(json, charsmax(json),
        "{^"event^":^"kill^",^"killer_id^":^"%s^",^"victim_id^":^"%s^",^"weapon^":^"%s^",^"kill_type^":^"%s^",^"headshot^":%s,^"victim_prone^":%s,^"killer_prone^":%s}",
        killer_steamid, victim_steamid, weapon, kill_type,
        headshot ? "true" : "false",
        victim_prone ? "true" : "false",
        killer_prone ? "true" : "false");
    do_send_json(json);
}

public task_poll_prone() {
    for (new id = 1; id <= get_maxplayers(); id++) {
        if (!is_user_connected(id) || !is_user_alive(id)) continue;

        new prone_raw = dod_get_pronestate(id);
        // PS_NOPRONE=0, PS_PRONE=1, PS_PRONEDEPLOY=2, PS_DEPLOY=3
        new prone_state;
        if (prone_raw == PS_NOPRONE)         prone_state = PRONE_STANDING;
        else if (prone_raw == PS_PRONE)      prone_state = PRONE_PRONE;
        else                                 prone_state = PRONE_DEPLOYED;

        if (prone_state != g_player_prone[id]) {
            g_player_prone[id] = prone_state;
            do_prone_change(id, prone_state);
        }
    }
}

public task_time_sync() {
    new timeleft = get_timeleft();

    new json[128];
    format(json, charsmax(json), "{^"event^":^"time_sync^",^"timeleft^":%d}", timeleft);
    do_send_json(json);
}

// ScoreShort: read_data(1)=id, read_data(2)=score, read_data(3)=kills, read_data(4)=deaths
public ev_player_score() {
    new id = read_data(1);
    if (!is_user_connected(id)) return;

    new steamid[32];
    get_steamid(id, steamid, charsmax(steamid));

    new score  = read_data(2);
    new kills  = read_data(3);
    new deaths = read_data(4);

    new json[256];
    format(json, charsmax(json),
        "{^"event^":^"player_score^",^"user_id^":^"%s^",^"kills^":%d,^"deaths^":%d,^"score^":%d}",
        steamid, kills, deaths, score);
    do_send_json(json);
}

public ev_team_score() {
    new allies = dod_get_team_score(TEAM_ALLIES);
    new axis   = dod_get_team_score(TEAM_AXIS);

    new json[128];
    format(json, charsmax(json),
        "{^"event^":^"team_score^",^"allies_score^":%d,^"axis_score^":%d}",
        allies, axis);
    do_send_json(json);
}

// ─── Chat ────────────────────────────────────────────────────────────────────

stock do_say(id, team_only) {
    new steamid[32], msg[128], msg_esc[256];
    get_steamid(id, steamid, charsmax(steamid));
    read_args(msg, charsmax(msg));
    remove_quotes(msg);
    escape_json(msg, msg_esc, charsmax(msg_esc));

    new json[384];
    format(json, charsmax(json),
        "{^"event^":^"user_say^",^"user_id^":^"%s^",^"team_only^":%s,^"message^":^"%s^"}",
        steamid, team_only ? "true" : "false", msg_esc);
    do_send_json(json);
    return PLUGIN_CONTINUE;
}

public ev_say(id)      { return do_say(id, 0); }
public ev_say_team(id) { return do_say(id, 1); }

// ─── Flag / Objective Events ──────────────────────────────────────────────────

stock do_flags_init() {
    g_flag_count = objectives_get_num();
    if (g_flag_count <= 0) return;

    static json[BUFFER_SIZE];
    static tmp[128];
    copy(json, charsmax(json), "{^"event^":^"flags_init^",^"flags^":[");

    for (new i = 0; i < g_flag_count && i < MAX_FLAGS; i++) {
        new owner = objective_get_data(i, CP_owner);
        g_flag_owner[i] = owner;

        new owner_str[16];
        if      (owner == TEAM_ALLIES) copy(owner_str, charsmax(owner_str), "allies");
        else if (owner == TEAM_AXIS)   copy(owner_str, charsmax(owner_str), "axis");
        else                           copy(owner_str, charsmax(owner_str), "neutral");

        new flag_name[64];
        objective_get_data(i, CP_name, flag_name, charsmax(flag_name));
        if (flag_name[0] == '^0') format(flag_name, charsmax(flag_name), "flag_%d", i);

        format(tmp, charsmax(tmp),
            "%s{^"flag_id^":%d,^"flag_name^":^"%s^",^"owner^":^"%s^"}",
            i > 0 ? "," : "", i, flag_name, owner_str);
        add(json, charsmax(json), tmp);
    }
    add(json, charsmax(json), "]}");
    do_send_json(json);
}

// InitObj fires whenever any objective changes
public ev_flags_update() {
    new count = objectives_get_num();

    for (new i = 0; i < count && i < MAX_FLAGS; i++) {
        new owner      = objective_get_data(i, CP_owner);
        new prev_owner = g_flag_owner[i];

        if (prev_owner == -1) {
            g_flag_owner[i] = owner;
            continue;
        }

        if (owner == prev_owner) continue;

        new owner_str[16];
        if      (owner == TEAM_ALLIES) copy(owner_str, charsmax(owner_str), "allies");
        else if (owner == TEAM_AXIS)   copy(owner_str, charsmax(owner_str), "axis");
        else                           copy(owner_str, charsmax(owner_str), "neutral");

        new flag_name[64];
        objective_get_data(i, CP_name, flag_name, charsmax(flag_name));
        if (flag_name[0] == '^0') format(flag_name, charsmax(flag_name), "flag_%d", i);

        if (owner == TEAM_ALLIES || owner == TEAM_AXIS) {
            new captor_json[256];
            do_build_captor_list(owner, captor_json, charsmax(captor_json));

            new cap_json[512];
            format(cap_json, charsmax(cap_json),
                "{^"event^":^"flag_cap_started^",^"flag_id^":%d,^"flag_name^":^"%s^",^"capping_team^":^"%s^",^"captor_ids^":[%s]}",
                i, flag_name, owner_str, captor_json);
            do_send_json(cap_json);

            format(cap_json, charsmax(cap_json),
                "{^"event^":^"flag_captured^",^"flag_id^":%d,^"flag_name^":^"%s^",^"new_owner^":^"%s^",^"captor_ids^":[%s]}",
                i, flag_name, owner_str, captor_json);
            do_send_json(cap_json);
        }

        g_flag_owner[i] = owner;
    }
}

stock do_build_captor_list(team, out[], len) {
    new bool:first = true;
    out[0] = '^0';
    new tmp[48];

    for (new id = 1; id <= get_maxplayers(); id++) {
        if (!is_user_connected(id) || !is_user_alive(id)) continue;
        if (get_user_team(id) != team) continue;

        new steamid[32];
        get_steamid(id, steamid, charsmax(steamid));
        format(tmp, charsmax(tmp), "%s^"%s^"", first ? "" : ",", steamid);
        add(out, len, tmp);
        first = false;
    }
}

// ─── Cap Zone Discovery & Polling ────────────────────────────────────────────

stock do_find_cap_zones() {
    g_capzone_count = 0;
    g_cvar_cap_time = get_cvar_float("dod_hud_cap_time");
    if (g_cvar_cap_time <= 0.0) g_cvar_cap_time = 20.0;

    new ent = -1;
    while ((ent = engfunc(EngFunc_FindEntityByString, ent, "classname", "dod_capture_area")) > 0) {
        if (g_capzone_count >= MAX_FLAGS) break;

        new Float:mins[3], Float:maxs[3];
        pev(ent, pev_absmin, mins);
        pev(ent, pev_absmax, maxs);

        // Only store if the entity has a real bounding box
        if (mins[0] == maxs[0] && mins[1] == maxs[1] && mins[2] == maxs[2]) continue;

        new i = g_capzone_count;
        g_capzone_ent[i] = ent;
        g_capzone_mins[i][0] = mins[0]; g_capzone_mins[i][1] = mins[1]; g_capzone_mins[i][2] = mins[2];
        g_capzone_maxs[i][0] = maxs[0]; g_capzone_maxs[i][1] = maxs[1]; g_capzone_maxs[i][2] = maxs[2];

        // Try to read cap time from entity — use fallback CVAR if unavailable
        g_cap_total_time[i] = g_cvar_cap_time;

        // Reset cap state
        g_cap_start_time[i] = 0.0;
        g_cap_capping_team[i] = 0;
        g_cap_contested[i] = false;
        g_zone_prev_allies[i] = 0;
        g_zone_prev_axis[i] = 0;

        g_capzone_count++;
    }

    server_print("[HUD] Found %d capture zones", g_capzone_count);
}

// Map a capture zone index to the closest flag index (by matching entity positions)
stock cap_zone_to_flag(zone_idx) {
    // If zone count matches flag count, assume 1:1 ordered mapping
    if (g_capzone_count == g_flag_count) return zone_idx;

    // Otherwise fall back to index (best effort)
    if (zone_idx < g_flag_count) return zone_idx;
    return -1;
}

stock bool:is_in_zone(id, zone_idx) {
    new Float:origin[3];
    pev(id, pev_origin, origin);

    return (origin[0] >= g_capzone_mins[zone_idx][0] && origin[0] <= g_capzone_maxs[zone_idx][0]
         && origin[1] >= g_capzone_mins[zone_idx][1] && origin[1] <= g_capzone_maxs[zone_idx][1]
         && origin[2] >= g_capzone_mins[zone_idx][2] && origin[2] <= g_capzone_maxs[zone_idx][2]);
}

public task_poll_cap_zones() {
    if (!g_authed || g_capzone_count <= 0) return;

    new maxp = get_maxplayers();
    new bool:changed = false;

    // Build current bitmasks and steam ID lists per zone
    static allies_bits[MAX_FLAGS];
    static axis_bits[MAX_FLAGS];

    for (new z = 0; z < g_capzone_count; z++) {
        allies_bits[z] = 0;
        axis_bits[z] = 0;
    }

    for (new id = 1; id <= maxp; id++) {
        if (!is_user_connected(id) || !is_user_alive(id)) continue;
        new team = g_player_team[id];
        if (team != TEAM_ALLIES && team != TEAM_AXIS) continue;

        for (new z = 0; z < g_capzone_count; z++) {
            if (is_in_zone(id, z)) {
                if (team == TEAM_ALLIES) allies_bits[z] |= (1 << id);
                else                     axis_bits[z] |= (1 << id);
            }
        }
    }

    // Check for changes and build events
    for (new z = 0; z < g_capzone_count; z++) {
        if (allies_bits[z] != g_zone_prev_allies[z] || axis_bits[z] != g_zone_prev_axis[z]) {
            changed = true;
        }
    }

    if (!changed) {
        // Still update cap progress even if occupancy unchanged
        do_update_cap_progress();
        return;
    }

    // Build flag_zone_players event
    static json[BUFFER_SIZE];
    static tmp[384];
    copy(json, charsmax(json), "{^"event^":^"flag_zone_players^",^"zones^":[");

    for (new z = 0; z < g_capzone_count; z++) {
        new flag_id = cap_zone_to_flag(z);
        if (flag_id < 0) continue;

        new allies_ids[384], axis_ids[384];
        do_build_zone_list(allies_bits[z], allies_ids, charsmax(allies_ids));
        do_build_zone_list(axis_bits[z], axis_ids, charsmax(axis_ids));

        format(tmp, charsmax(tmp),
            "%s{^"flag_id^":%d,^"allies_ids^":[%s],^"axis_ids^":[%s]}",
            z > 0 ? "," : "", flag_id, allies_ids, axis_ids);
        add(json, charsmax(json), tmp);

        // ── Cap contested detection ──
        new bool:allies_present = (allies_bits[z] != 0);
        new bool:axis_present   = (axis_bits[z] != 0);
        new bool:was_contested  = g_cap_contested[z];
        new bool:now_contested  = (allies_present && axis_present);

        if (now_contested && !was_contested) {
            // Just became contested — send event
            new contesting_team = (g_cap_capping_team[z] == TEAM_ALLIES) ? TEAM_AXIS : TEAM_ALLIES;
            new contesting_bits = (contesting_team == TEAM_ALLIES) ? allies_bits[z] : axis_bits[z];

            new contester_list[256];
            do_build_zone_list(contesting_bits, contester_list, charsmax(contester_list));

            new contest_team_str[16];
            get_team_str(contesting_team, contest_team_str, charsmax(contest_team_str));

            new flag_name[64];
            if (flag_id < g_flag_count) {
                objective_get_data(flag_id, CP_name, flag_name, charsmax(flag_name));
                if (flag_name[0] == '^0') format(flag_name, charsmax(flag_name), "flag_%d", flag_id);
            }

            new contest_json[512];
            format(contest_json, charsmax(contest_json),
                "{^"event^":^"flag_cap_contested^",^"flag_id^":%d,^"flag_name^":^"%s^",^"contesting_team^":^"%s^",^"contester_ids^":[%s]}",
                flag_id, flag_name, contest_team_str, contester_list);
            do_send_json(contest_json);
        }
        g_cap_contested[z] = now_contested;

        // ── Cap progress tracking ──
        new owner = (flag_id < g_flag_count) ? g_flag_owner[flag_id] : -1;
        new bool:allies_capping = (allies_present && !axis_present && owner != TEAM_ALLIES);
        new bool:axis_capping   = (axis_present && !allies_present && owner != TEAM_AXIS);

        if (allies_capping && g_cap_capping_team[z] != TEAM_ALLIES) {
            // Allies started capping
            g_cap_start_time[z] = get_gametime();
            g_cap_capping_team[z] = TEAM_ALLIES;
        } else if (axis_capping && g_cap_capping_team[z] != TEAM_AXIS) {
            // Axis started capping
            g_cap_start_time[z] = get_gametime();
            g_cap_capping_team[z] = TEAM_AXIS;
        } else if (!allies_capping && !axis_capping) {
            // Nobody capping (contested, empty, or already owned)
            g_cap_capping_team[z] = 0;
            g_cap_start_time[z] = 0.0;
        }

        g_zone_prev_allies[z] = allies_bits[z];
        g_zone_prev_axis[z]   = axis_bits[z];
    }

    add(json, charsmax(json), "]}");
    do_send_json(json);

    do_update_cap_progress();
}

stock do_update_cap_progress() {
    for (new z = 0; z < g_capzone_count; z++) {
        if (g_cap_capping_team[z] == 0 || g_cap_start_time[z] == 0.0) continue;
        if (g_cap_contested[z]) continue;  // Progress paused while contested

        new flag_id = cap_zone_to_flag(z);
        if (flag_id < 0) continue;

        new Float:elapsed = get_gametime() - g_cap_start_time[z];
        new Float:total = g_cap_total_time[z];
        new Float:progress = elapsed / total;
        if (progress > 1.0) progress = 1.0;
        if (progress < 0.0) progress = 0.0;

        new cap_team_str[16];
        get_team_str(g_cap_capping_team[z], cap_team_str, charsmax(cap_team_str));

        // Send as integer percentage (0-100) to avoid float formatting issues in Pawn
        new pct = floatround(progress * 100.0);

        new json[256];
        format(json, charsmax(json),
            "{^"event^":^"flag_cap_progress^",^"flag_id^":%d,^"progress^":%d,^"capping_team^":^"%s^"}",
            flag_id, pct, cap_team_str);
        do_send_json(json);
    }
}

stock do_build_zone_list(bits, out[], len) {
    new bool:first = true;
    out[0] = '^0';
    new tmp[48];

    for (new id = 1; id <= MAX_PLAYERS; id++) {
        if (!(bits & (1 << id))) continue;

        new steamid[32];
        get_steamid(id, steamid, charsmax(steamid));
        format(tmp, charsmax(tmp), "%s^"%s^"", first ? "" : ",", steamid);
        add(out, len, tmp);
        first = false;
    }
}

// ─── Caster Observed Player ──────────────────────────────────────────────────

public cmd_observe(id, level, cid) {
    if (!cmd_access(id, ADMIN_RCON, cid, 2)) return PLUGIN_HANDLED;

    new arg[32];
    read_argv(1, arg, charsmax(arg));

    new json[128];
    format(json, charsmax(json),
        "{^"event^":^"caster_observed_player^",^"user_id^":^"%s^"}", arg);
    do_send_json(json);

    return PLUGIN_HANDLED;
}
