// ─────────────────────────────────────────────────────────────────────────────
// KTP Timer Probe — LOCAL-ONLY diagnostic plugin. NEVER ship to production.
//
// Purpose: empirically characterize the DoD half-clock across a real match
// go-live (mp_clan_restartround → mp_clan_timer countdown → engine timer
// rebase), for the Phase-2 dodx_get_round_time() work. Logs every clock
// source at 1 Hz plus event-edge markers, all via server_print → lands in
// the container console log (docker logs ktpinfrastructure-ktp-game-1-1).
//
// Ground-truth sampling: a human on a connected client types `.timecheck`
// while reading the on-screen HUD clock; the probe logs a marker line at
// that instant. Comparing the marker's clock values against what the human
// saw identifies the authoritative field and its error.
//
// Line format (grep-friendly):
//   [TPROBE] t=<systime> gt=<gametime> tl=<get_timeleft> <extras>
//   [TPROBE] EDGE <what> ...            — event markers
//   [TPROBE] TIMECHECK ...              — human ground-truth marker
//
// M2: compile with PROBE_WITH_DUMP=1 once the dodx diagnostic native
// dodx_test_dump_round_timers() exists in the loaded module — adds the
// gamerules timer-field dump to every 1 Hz tick.
// ─────────────────────────────────────────────────────────────────────────────
#include <amxmodx>
#include <amxmisc>
#include <dodx>

#define PROBE_TASK_ID 90210

new bool:g_probe_on = true;

public plugin_init() {
    register_plugin("KTP Timer Probe", "0.1.0", "KTP");

    register_clcmd("say .timecheck",      "cmd_timecheck");
    register_clcmd("say_team .timecheck", "cmd_timecheck");
    register_concmd("amx_timeprobe", "cmd_toggle", ADMIN_RCON,
        "- toggle the 1 Hz timer probe logging");

    // Log EVERY RoundState message with its value — locally definitive data on
    // whether the engine emits RoundState==1 at go-live (prod never sees it).
    new msgRoundState = get_user_msgid("RoundState");
    if (msgRoundState > 0) {
        register_message(msgRoundState, "msg_round_state");
    }
}

public plugin_cfg() {
    // plugin_cfg, not plugin_init: repeating tasks scheduled in plugin_init
    // don't survive changelevel (see DoD-hud-observer CLAUDE.md).
    set_task(1.0, "task_probe", PROBE_TASK_ID, _, _, "b");
    server_print("[TPROBE] armed (1 Hz). rcon amx_timeprobe toggles; .timecheck marks.");
}

probe_line(const tag[], const extra[] = "") {
#if defined PROBE_WITH_DUMP
    server_print("[TPROBE] %s t=%d gt=%.3f tl=%d rt=%.2f%s",
        tag, get_systime(), get_gametime(), get_timeleft(), dodx_get_round_time(), extra);
#else
    server_print("[TPROBE] %s t=%d gt=%.3f tl=%d%s",
        tag, get_systime(), get_gametime(), get_timeleft(), extra);
#endif
}

public task_probe() {
    if (!g_probe_on) return;
    probe_line("tick");
#if defined PROBE_WITH_DUMP
    dodx_test_dump_round_timers();
    // Gamerules change-scan: across the go-live edge the real half-clock
    // anchor member shows up as a changed dword (the gamedata-known timer
    // fields all proved dead on standard maps).
    dodx_test_scan_gamerules();
#endif
}

public cmd_toggle(id, level, cid) {
    if (!cmd_access(id, level, cid, 1)) return PLUGIN_HANDLED;
    g_probe_on = !g_probe_on;
    server_print("[TPROBE] logging %s", g_probe_on ? "ON" : "OFF");
    console_print(id, "[TPROBE] logging %s", g_probe_on ? "ON" : "OFF");
    return PLUGIN_HANDLED;
}

// Human ground-truth marker: the player reads the client's on-screen clock at
// the instant they hit enter; this line records what every server-side clock
// said at that same instant. PLUGIN_CONTINUE so other plugins still see the say.
public cmd_timecheck(id) {
    new name[32];
    get_user_name(id, name, charsmax(name));
    new extra[64];
    formatex(extra, charsmax(extra), " by=%s", name);
    probe_line("TIMECHECK", extra);
#if defined PROBE_WITH_DUMP
    dodx_test_dump_round_timers();
#endif
    client_print(id, print_chat, "[TPROBE] marked - note your HUD clock NOW");
    return PLUGIN_CONTINUE;
}

// ─── Event-edge markers ──────────────────────────────────────────────────────

public ktp_match_start(const matchId[], const map[], matchType, half) {
    new extra[128];
    formatex(extra, charsmax(extra), " match=%s half=%d clan_timer=%.1f timelimit=%.1f",
        matchId, half, get_cvar_float("mp_clan_timer"), get_cvar_float("mp_timelimit"));
    probe_line("EDGE ktp_match_start", extra);
}

public ktp_match_end(const matchId[], const map[], matchType, team1Score, team2Score) {
    probe_line("EDGE ktp_match_end");
}

public msg_round_state() {
    new extra[32];
    formatex(extra, charsmax(extra), " state=%d", get_msg_arg_int(1));
    probe_line("EDGE RoundState", extra);
#if defined PROBE_WITH_DUMP
    dodx_test_dump_round_timers();
#endif
    return PLUGIN_CONTINUE;
}

// Spawn batch marker — the go-live mass-respawn is coincident with the engine
// timer rebase; client_spawn edges bracket the exact rebase moment.
public dod_client_spawn(id) {
    static Float:last_logged;
    new Float:now = get_gametime();
    if (now - last_logged > 0.5) {   // collapse a respawn wave into one line
        last_logged = now;
        probe_line("EDGE spawn_wave");
    }
}
