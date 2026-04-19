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

// ─── Constants ───────────────────────────────────────────────────────────────

#define PLUGIN  "KTP HUD Observer"
#define VERSION "2.0.0"
#define AUTHOR  "cadaver"

#define MAX_PLAYERS     32
#define MAX_FLAGS       32
#define MAX_CAPTORS     12
#define TIME_SYNC_DELAY 30.0
#define PRONE_POLL_INTERVAL 0.25
#define ZONE_POLL_INTERVAL  0.5
#define BUFFER_SIZE     2048
#define CURL_TIMEOUT_MS 1000

// Task IDs — used to clear stale tasks on map change before re-scheduling.
// AMXX task persistence across changelevel is inconsistent in practice;
// we reschedule in plugin_cfg and remove_task() defensively to avoid dupes.
#define TASK_ID_INIT_CONFIG  9001
#define TASK_ID_POLL_PRONE   9002
#define TASK_ID_POLL_ZONES   9003
#define TASK_ID_TIME_SYNC    9004
#define TASK_ID_EMIT_FLAGS   9005

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

// Curl persistent headers (built once in plugin_init, never freed)
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

// Player state
new g_player_team[MAX_PLAYERS + 1];
new g_player_prone[MAX_PLAYERS + 1];
new g_player_alive[MAX_PLAYERS + 1];

// Local kill counter — authoritative for the HUD. We can't rely on v.frags
// at client_death time because DODX's Damage-hook path fires the forward
// before the engine's CDODPlayer::Killed() has incremented frags. Reset on
// connect, disconnect, and ktp_match_start (half reset).
new g_player_kills[MAX_PLAYERS + 1];

// Flag ownership cache
new g_flag_owner[MAX_FLAGS];
new g_flag_count;

// Flag metadata cache (read once at flags_init)
new g_flag_name_cache[MAX_FLAGS][64];

// Current cap state per flag (mirror of game-authoritative CAreaCapture fields)
// capping_team: 0=none, 1=allies, 2=axis
new g_flag_capping_team[MAX_FLAGS];
new bool:g_flag_contested[MAX_FLAGS];
new g_flag_last_progress[MAX_FLAGS];     // last-emitted progress %, to avoid spam
new g_flag_prev_allies_count[MAX_FLAGS];
new g_flag_prev_axis_count[MAX_FLAGS];

// Debounce: CA_is_capturing and CA_num_allies/axis occasionally pulse non-zero
// for a single tick when nobody is on the point (observed on dod_anzio at map
// start — Bridge + Plaza both read is_capping=1, num_allies=1, num_axis=1).
// Require the raw state to persist for CAP_DEBOUNCE_TICKS polls before we
// believe it and emit cap_started/stopped/contested.
#define CAP_DEBOUNCE_TICKS 3
new g_flag_pending_capper[MAX_FLAGS];
new g_flag_pending_ticks[MAX_FLAGS];

// Settling window: suppress all cap-state emissions for N seconds after map
// load so the game-side entity state can stabilize. flag_zone_players counts
// still flow for display, but we don't emit started/stopped/contested.
#define CAP_SETTLE_SECONDS 5.0
new Float:g_cap_settle_until;

// Pending captor batch — populated by dod_score_event during a successful cap,
// drained on the next dod_control_point_captured for that CP. Mirrors KTPScoreTracker.
new g_flag_pending_captor_ids[MAX_FLAGS][MAX_CAPTORS];
new g_flag_pending_captor_count[MAX_FLAGS];

// Server hostname (sent as X-Server-Hostname header)
new g_hostname[64];

// ─── Plugin Lifecycle ────────────────────────────────────────────────────────

public plugin_init() {
    register_plugin(PLUGIN, VERSION, AUTHOR);

    register_cvar("dod_hud_url", "http://127.0.0.1:8088/ingest", FCVAR_SERVER);
    register_cvar("dod_hud_key", "",                              FCVAR_PROTECTED);

    // Round events (log events)
    register_logevent("ev_round_start", 2, "1=World triggered", "2=Round_Start");
    register_logevent("ev_round_end",   2, "1=World triggered", "2=Round_End");

    // Game events
    register_event("TeamScore",  "ev_team_score",   "a");
    register_event("ScoreShort", "ev_player_score", "a");

    // Chat
    register_clcmd("say",      "ev_say");
    register_clcmd("say_team", "ev_say_team");

    // Admin command: caster observe
    register_concmd("amx_dod_observe", "cmd_observe", ADMIN_RCON, "<steamid> — caster observe");

    // Diagnostic: dump raw CAreaCapture values for every CP (server console only)
    register_concmd("amx_hud_dump_zones", "cmd_dump_zones", ADMIN_RCON, "dump raw zone state");

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
        g_flag_owner[i] = -1;
        g_flag_pending_capper[i] = 0;
        g_flag_pending_ticks[i]  = 0;
    }
    g_flag_count = 0;

    // Don't emit cap events for the first few seconds after map load
    g_cap_settle_until = get_gametime() + CAP_SETTLE_SECONDS;

    // Clear any stragglers from the previous map, then re-arm.
    remove_task(TASK_ID_INIT_CONFIG);
    remove_task(TASK_ID_POLL_PRONE);
    remove_task(TASK_ID_POLL_ZONES);
    remove_task(TASK_ID_TIME_SYNC);
    remove_task(TASK_ID_EMIT_FLAGS);

    // Defer CVAR + header init to ensure amxx.cfg has loaded
    set_task(1.0, "task_init_config", TASK_ID_INIT_CONFIG);

    set_task(PRONE_POLL_INTERVAL, "task_poll_prone", TASK_ID_POLL_PRONE, _, _, "b");
    set_task(ZONE_POLL_INTERVAL,  "task_poll_zones", TASK_ID_POLL_ZONES, _, _, "b");
    set_task(TIME_SYNC_DELAY,     "task_time_sync",  TASK_ID_TIME_SYNC,  _, _, "b");
    set_task(30.0,                "task_emit_flags", TASK_ID_EMIT_FLAGS, _, _, "b");
}

public task_init_config() {
    // Read CVARs
    get_cvar_string("dod_hud_url", g_cvar_url, charsmax(g_cvar_url));
    get_cvar_string("dod_hud_key", g_cvar_key, charsmax(g_cvar_key));
    get_cvar_string("hostname",    g_hostname,  charsmax(g_hostname));

    // Build persistent curl headers (once, reused for every POST)
    if (g_curlHeaders != SList_Empty) {
        curl_slist_free_all(g_curlHeaders);
        g_curlHeaders = SList_Empty;
    }

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

    server_print("[HUD] Initialized — URL: %s  Auth: %s  Hostname: %s",
        g_cvar_url,
        g_cvar_key[0] ? "(set)" : "(none)",
        g_hostname);

    // Send flags snapshot now that URL is set (controlpoints_init fires before CVARs load)
    do_flags_init();
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

// ─── KTPMatchHandler Forwards ────────────────────────────────────────────────

// half: 1=1st half, 2=2nd half, 101+=OT round
public ktp_match_start(const matchId[], const map[], MatchType:matchType, half) {
    g_matchActive = true;
    copy(g_matchId,  charsmax(g_matchId),  matchId);
    copy(g_matchMap, charsmax(g_matchMap), map);
    g_matchType = _:matchType;
    g_matchHalf = half;

    // Reset per-player kill counters — stats wipe on half start.
    for (new i = 1; i <= MAX_PLAYERS; i++) g_player_kills[i] = 0;

    server_print("[HUD] Match started: %s (map=%s type=%d half=%d)", matchId, map, _:matchType, half);

    // Send half_start event
    new timeleft = get_timeleft();
    new json[128];
    formatex(json, charsmax(json),
        "{^"event^":^"half_start^",^"half^":%d,^"timeleft^":%d}",
        half, timeleft);
    post_event(json);

    // Refresh flag state and send roster dump
    do_flags_init();
    do_roster_dump();
}

public ktp_match_end(const matchId[], const map[], MatchType:matchType, team1Score, team2Score) {
    server_print("[HUD] Match ended: %s (allies=%d axis=%d)", matchId, team1Score, team2Score);

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
}

// ─── Roster Dump ─────────────────────────────────────────────────────────────

// Send player_connect + player_spawn for every connected player.
// Called on match start so the HUD gets a full snapshot.
stock do_roster_dump() {
    new maxp = get_maxplayers();
    new count = 0;

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

        new json[256];
        formatex(json, charsmax(json),
            "{^"event^":^"player_connect^",^"user_id^":^"%s^",^"name^":^"%s^",^"team^":^"%s^"}",
            steamid, name_esc, team_str);
        post_event(json);

        // If alive and on a real team, also send spawn state
        if (is_user_alive(id) && (team == TEAM_ALLIES || team == TEAM_AXIS)) {
            new class_id = dod_get_user_class(id);
            new wpn_primary[32], wpn_secondary[32];
            get_wpn_name_for_slot(id, DODWT_PRIMARY,   wpn_primary,   charsmax(wpn_primary));
            get_wpn_name_for_slot(id, DODWT_SECONDARY, wpn_secondary, charsmax(wpn_secondary));

            g_player_prone[id] = PRONE_STANDING;
            g_player_alive[id] = 1;

            formatex(json, charsmax(json),
                "{^"event^":^"player_spawn^",^"user_id^":^"%s^",^"team^":^"%s^",^"class_id^":%d,^"weapon_primary^":^"%s^",^"weapon_secondary^":^"%s^"}",
                steamid, team_str, class_id, wpn_primary, wpn_secondary);
            post_event(json);
        }

        count++;
    }
}

// ─── Round Events ────────────────────────────────────────────────────────────

public ev_round_start() {
    new timeleft = get_timeleft();

    new json[128];
    formatex(json, charsmax(json),
        "{^"event^":^"round_start^",^"timeleft^":%d}", timeleft);
    post_event(json);

    // Refresh flag state on round start
    do_flags_init();
}

public ev_round_end() {
    new allies = dod_get_team_score(TEAM_ALLIES);
    new axis   = dod_get_team_score(TEAM_AXIS);

    new winner[16];
    if (allies > axis)      copy(winner, charsmax(winner), "allies");
    else if (axis > allies) copy(winner, charsmax(winner), "axis");
    else                    copy(winner, charsmax(winner), "draw");

    new json[256];
    formatex(json, charsmax(json),
        "{^"event^":^"round_end^",^"winner^":^"%s^",^"end_type^":^"objectives^",^"allies_score^":%d,^"axis_score^":%d}",
        winner, allies, axis);
    post_event(json);
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

    g_player_team[id]  = TEAM_UNASSIGNED;
    g_player_prone[id] = PRONE_STANDING;
    g_player_alive[id] = 0;
    g_player_kills[id] = 0;

    new json[256];
    formatex(json, charsmax(json),
        "{^"event^":^"player_connect^",^"user_id^":^"%s^",^"name^":^"%s^",^"team^":^"%s^"}",
        steamid, name_esc, team_str);
    post_event(json);
}

public client_disconnect(id) {
    if (is_user_hltv(id)) return;

    new steamid[32];
    get_steamid(id, steamid, charsmax(steamid));

    new json[128];
    formatex(json, charsmax(json),
        "{^"event^":^"player_disconnect^",^"user_id^":^"%s^"}", steamid);
    post_event(json);

    g_player_team[id]  = 0;
    g_player_prone[id] = PRONE_STANDING;
    g_player_alive[id] = 0;
    g_player_kills[id] = 0;
}

// DODX forward: player spawned
public dod_client_spawn(id) {
    if (is_user_hltv(id)) return;
    if (!is_user_alive(id)) return;

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

    new json[384];
    formatex(json, charsmax(json),
        "{^"event^":^"player_spawn^",^"user_id^":^"%s^",^"name^":^"%s^",^"team^":^"%s^",^"class_id^":%d,^"weapon_primary^":^"%s^",^"weapon_secondary^":^"%s^"}",
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
}

// DODX forward: client_damage (fires on every hit)
public client_damage(attacker, victim, damage, wpnindex, hitplace, TK) {
    if (attacker < 1 || attacker > MAX_PLAYERS) return;
    if (victim < 1 || victim > MAX_PLAYERS) return;

    new attacker_steam[35], victim_steam[35], weapon[32];
    get_steamid(attacker, attacker_steam, charsmax(attacker_steam));
    get_steamid(victim, victim_steam, charsmax(victim_steam));
    xmod_get_wpnlogname(wpnindex, weapon, charsmax(weapon));

    new victim_health = get_user_health(victim);

    new json[512];
    formatex(json, charsmax(json),
        "{^"event^":^"damage^",^"attacker_id^":^"%s^",^"victim_id^":^"%s^",^"damage^":%d,^"weapon^":^"%s^",^"hitplace^":%d,^"victim_health^":%d}",
        attacker_steam, victim_steam, damage, weapon, hitplace, victim_health);
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

    g_player_alive[victim] = 0;
    g_player_prone[victim] = PRONE_STANDING;

    new json[512];
    formatex(json, charsmax(json),
        "{^"event^":^"kill^",^"killer_id^":^"%s^",^"victim_id^":^"%s^",^"weapon^":^"%s^",^"kill_type^":^"%s^",^"headshot^":%s,^"victim_prone^":%s,^"killer_prone^":%s}",
        killer_steamid, victim_steamid, weapon, kill_type,
        headshot ? "true" : "false",
        victim_prone ? "true" : "false",
        killer_prone ? "true" : "false");
    post_event(json);

    // DoD's engine fires ScoreShort when death count changes (via set_user_deaths)
    // but not on frag increments — the HL scoreboard reads v.frags directly, so no
    // message is needed for kills. Emit player_score for the killer explicitly so
    // the HUD backend sees the new kill count.
    //
    // Track kills locally: reading v.frags here is off-by-one because DODX's
    // Damage-hook path fires client_death BEFORE the engine's Killed() has
    // incremented frags. Mirror DoD frag semantics: +1 normal, -1 teamkill, 0 suicide.
    if (killer != victim && is_user_connected(killer)) {
        if (TK) g_player_kills[killer]--;
        else    g_player_kills[killer]++;
        emit_player_score(killer);
    }
}

stock emit_player_score(id) {
    new steamid[32];
    get_steamid(id, steamid, charsmax(steamid));

    new kills  = g_player_kills[id];
    new deaths = get_user_deaths(id);
    new score  = dod_get_user_score(id);

    new json[256];
    formatex(json, charsmax(json),
        "{^"event^":^"player_score^",^"user_id^":^"%s^",^"kills^":%d,^"deaths^":%d,^"score^":%d}",
        steamid, kills, deaths, score);
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

// Polling fallback: catches deployed state transitions that dod_client_prone misses
public task_poll_prone() {
    for (new id = 1; id <= get_maxplayers(); id++) {
        if (!is_user_connected(id) || !is_user_alive(id)) continue;

        new prone_raw = dod_get_pronestate(id);
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

// ScoreShort: read_data(1)=id, read_data(2)=score, read_data(3)=kills, read_data(4)=deaths
// DoD fires ScoreShort on death-count changes only. Use g_player_kills (locally
// tracked from client_death) as the authoritative kills value to avoid clobbering
// with the stale v.frags in the ScoreShort payload.
public ev_player_score() {
    new id = read_data(1);
    if (!is_user_connected(id)) return;

    new steamid[32];
    get_steamid(id, steamid, charsmax(steamid));

    new score  = read_data(2);
    new kills  = g_player_kills[id];
    new deaths = read_data(4);

    new json[256];
    formatex(json, charsmax(json),
        "{^"event^":^"player_score^",^"user_id^":^"%s^",^"kills^":%d,^"deaths^":%d,^"score^":%d}",
        steamid, kills, deaths, score);
    post_event(json);
}

public ev_team_score() {
    new allies = dod_get_team_score(TEAM_ALLIES);
    new axis   = dod_get_team_score(TEAM_AXIS);

    new json[128];
    formatex(json, charsmax(json),
        "{^"event^":^"team_score^",^"allies_score^":%d,^"axis_score^":%d}",
        allies, axis);
    post_event(json);
}

public task_time_sync() {
    new timeleft = get_timeleft();

    new json[128];
    formatex(json, charsmax(json),
        "{^"event^":^"time_sync^",^"timeleft^":%d}", timeleft);
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

    for (new f = 0; f < g_flag_count && f < MAX_FLAGS; f++) {
        new ac = dodx_area_get_data(f, CA_num_allies);
        new xc = dodx_area_get_data(f, CA_num_axis);
        if (ac < 0) ac = 0;
        if (xc < 0) xc = 0;

        // Required cappers per team (static per flag, set in cap_area entity keyvalues).
        new an = dodx_area_get_data(f, CA_allies_numcap);
        new xn = dodx_area_get_data(f, CA_axis_numcap);
        if (an < 1) an = 1;
        if (xn < 1) xn = 1;

        // Zone counts — emit every tick so UI can clear when zones empty.
        static zbuf[160];
        formatex(zbuf, charsmax(zbuf),
            "%s{^"flag_id^":%d,^"allies_count^":%d,^"axis_count^":%d,^"allies_numcap^":%d,^"axis_numcap^":%d}",
            first_zone ? "" : ",", f, ac, xc, an, xn);
        add(zones_json, charsmax(zones_json), zbuf);
        first_zone = false;

        // ── Cap state transitions (game-authoritative, with debounce) ──
        // Raw read from the CAreaCapture entity. Can pulse at map start or
        // when spawns cycle near a zone — require N consecutive identical
        // polls before committing a state change.
        new is_capping  = dodx_area_get_data(f, CA_is_capturing);
        new raw_capper  = is_capping ? dodx_area_get_data(f, CA_capturing_team) : 0;

        new committed_capper = g_flag_capping_team[f];
        if (raw_capper == g_flag_pending_capper[f]) {
            if (g_flag_pending_ticks[f] < CAP_DEBOUNCE_TICKS) g_flag_pending_ticks[f]++;
        } else {
            g_flag_pending_capper[f] = raw_capper;
            g_flag_pending_ticks[f]  = 1;
        }

        new bool:settling     = (get_gametime() < g_cap_settle_until);
        new bool:commit_ready = (g_flag_pending_ticks[f] >= CAP_DEBOUNCE_TICKS) && !settling;

        if (commit_ready && raw_capper != committed_capper) {
            new bool:was_contested = g_flag_contested[f];

            new bool:now_contested = false;
            if (raw_capper == TEAM_ALLIES && xc > 0) now_contested = true;
            if (raw_capper == TEAM_AXIS   && ac > 0) now_contested = true;

            if (committed_capper == 0 && raw_capper != 0) {
                g_flag_capping_team[f]   = raw_capper;
                g_flag_contested[f]      = now_contested;
                g_flag_last_progress[f]  = -1;
                emit_cap_started(f, raw_capper);
            }
            else if (committed_capper != 0 && raw_capper == 0) {
                g_flag_capping_team[f]  = 0;
                g_flag_contested[f]     = false;
                g_flag_last_progress[f] = -1;
                emit_cap_stopped(f, committed_capper);
            }
            else if (committed_capper != 0 && raw_capper != 0 && committed_capper != raw_capper) {
                g_flag_capping_team[f]  = raw_capper;
                g_flag_contested[f]     = now_contested;
                g_flag_last_progress[f] = -1;
                emit_cap_stopped(f, committed_capper);
                emit_cap_started(f, raw_capper);
            }

            if (g_flag_capping_team[f] != 0 && now_contested && !was_contested) {
                g_flag_contested[f] = true;
                new contesting_team = (g_flag_capping_team[f] == TEAM_ALLIES) ? TEAM_AXIS : TEAM_ALLIES;
                new contester_count = (contesting_team == TEAM_ALLIES) ? ac : xc;
                emit_cap_contested(f, contesting_team, contester_count);
            } else if (g_flag_capping_team[f] != 0 && !now_contested && was_contested) {
                g_flag_contested[f] = false;
            }
        }

        // Progress tick (derived from m_fTimeRemaining / m_nCapTime).
        if (g_flag_capping_team[f] != 0) {
            new Float:remaining = Float:dodx_area_get_data(f, CA_time_remaining);
            new cap_time        = dodx_area_get_data(f, CA_timetocap);
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
    do_flags_init();
}

stock do_flags_init() {
    g_flag_count = dodx_objectives_get_num();
    if (g_flag_count <= 0) return;

    static json[BUFFER_SIZE];
    static tmp[128];
    copy(json, charsmax(json), "{^"event^":^"flags_init^",^"flags^":[");

    for (new i = 0; i < g_flag_count && i < MAX_FLAGS; i++) {
        new owner = dodx_objective_get_data(i, CP_owner);
        g_flag_owner[i] = owner;

        g_flag_capping_team[i]          = 0;
        g_flag_contested[i]             = false;
        g_flag_last_progress[i]         = -1;
        g_flag_prev_allies_count[i]     = 0;
        g_flag_prev_axis_count[i]       = 0;
        g_flag_pending_captor_count[i]  = 0;

        new owner_str[16];
        if      (owner == TEAM_ALLIES) copy(owner_str, charsmax(owner_str), "allies");
        else if (owner == TEAM_AXIS)   copy(owner_str, charsmax(owner_str), "axis");
        else                           copy(owner_str, charsmax(owner_str), "neutral");

        new flag_name[64];
        dodx_objective_get_data(i, CP_name, flag_name, charsmax(flag_name));
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
// Fires once per player credited with a CP cap. We batch by cp_index and drain
// on dod_control_point_captured. Pattern lifted from KTPScoreTracker.
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

    g_flag_pending_captor_ids[cp_index][n] = id;
    g_flag_pending_captor_count[cp_index]  = n + 1;
}

// DODX forward: control point captured
public dod_control_point_captured(cp_index, new_owner, old_owner) {
    if (cp_index < 0 || cp_index >= MAX_FLAGS) return;

    new owner_str[16];
    if      (new_owner == TEAM_ALLIES) copy(owner_str, charsmax(owner_str), "allies");
    else if (new_owner == TEAM_AXIS)   copy(owner_str, charsmax(owner_str), "axis");
    else                               copy(owner_str, charsmax(owner_str), "neutral");

    new flag_name[64];
    dodx_objective_get_data(cp_index, CP_name, flag_name, charsmax(flag_name));
    if (flag_name[0] == '^0') formatex(flag_name, charsmax(flag_name), "flag_%d", cp_index);

    // Captors collected via dod_score_event during this cap.
    new captor_json[256];
    build_pending_captor_list(cp_index, new_owner, captor_json, charsmax(captor_json));

    new json[512];
    formatex(json, charsmax(json),
        "{^"event^":^"flag_captured^",^"flag_id^":%d,^"flag_name^":^"%s^",^"new_owner^":^"%s^",^"captor_ids^":[%s]}",
        cp_index, flag_name, owner_str, captor_json);
    post_event(json);

    g_flag_owner[cp_index]                = new_owner;
    g_flag_capping_team[cp_index]         = 0;
    g_flag_contested[cp_index]            = false;
    g_flag_last_progress[cp_index]        = -1;
    g_flag_pending_captor_count[cp_index] = 0;
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
}

// ─── Caster Observed Player ──────────────────────────────────────────────────

public cmd_dump_zones(id, level, cid) {
    if (!cmd_access(id, ADMIN_RCON, cid, 1)) return PLUGIN_HANDLED;

    server_print("[HUD] zone dump (count=%d, settling=%s)",
        g_flag_count,
        (get_gametime() < g_cap_settle_until) ? "yes" : "no");

    for (new f = 0; f < g_flag_count && f < MAX_FLAGS; f++) {
        new ac = dodx_area_get_data(f, CA_num_allies);
        new xc = dodx_area_get_data(f, CA_num_axis);
        new an = dodx_area_get_data(f, CA_allies_numcap);
        new xn = dodx_area_get_data(f, CA_axis_numcap);
        new isc = dodx_area_get_data(f, CA_is_capturing);
        new ct  = dodx_area_get_data(f, CA_capturing_team);
        new ot  = dodx_area_get_data(f, CA_owning_team);
        new Float:tr = Float:dodx_area_get_data(f, CA_time_remaining);
        new ct_total = dodx_area_get_data(f, CA_timetocap);

        server_print("[HUD] CP[%d] '%s' own=%d cap=%d/team=%d  a=%d/%d x=%d/%d  t=%.1f/%d  committed=%d pending=%d/%d",
            f, g_flag_name_cache[f], ot, isc, ct, ac, an, xc, xn,
            tr, ct_total, g_flag_capping_team[f],
            g_flag_pending_capper[f], g_flag_pending_ticks[f]);
    }
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
