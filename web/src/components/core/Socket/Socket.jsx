import React, { useEffect } from 'react';
import socketio from 'socket.io-client';
import create from 'zustand';
import gameEvents from '../gameEvents';

// Origin-relative: when REACT_APP_SOCKET_URL is unset (the single-origin proxy
// deployments — local docker at https://localhost, prod at https://hud.ktpdod.com),
// dial the SAME origin the page is served from, so one build works at any origin
// with no baked hostname and no mixed-content mismatch. Dev workflows
// (`npm run web`) set REACT_APP_SOCKET_URL explicitly and keep their split ports.
const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || window.location.origin;
export const socket = socketio.connect(SOCKET_URL, { withCredentials: true });

// Read ?match=, ?server=, and ?replay= from URL
const urlParams = new URLSearchParams(window.location.search);
const matchIdParam = urlParams.get('match');
const serverParam = urlParams.get('server');
const isReplay = urlParams.get('replay') === 'true';

socket.on('connect', () => {
    if (isReplay) {
        // Replay mode — don't join any live room, events come from Replay component
        console.log('[socket] Replay mode — not joining any live room');
        return;
    }
    if (serverParam) {
        // Server mode — observe a game server (pre-match or live)
        socket.emit('join_server', serverParam);
        console.log(`[socket] Joining server room: ${serverParam}`);
    } else if (matchIdParam) {
        socket.emit('join_match', matchIdParam);
        console.log(`[socket] Joining match room: ${matchIdParam}`);
    } else {
        // Legacy fallback — join the old broadcast room
        socket.emit('hud_socket');
        console.log('[socket] No match/server param, joined legacy hud_socket room');
    }
});

// Forward all live socket events into the shared game event bus
socket.onAny((event, msg) => {
    console.log('[socket]', event, msg);
    if (!isReplay) {
        gameEvents.emit(event, msg);
    }
});

// Persistent player directory — maps user_id to {name, team}.
// Updated on every player event, never cleared. Fallback for kill feed resolution
// when the player isn't yet in a team array (e.g. connect arrives with team "spectator").
const playerDirectory = {};

// Monotonic counters for stable React keys + addedAt timestamps for
// render-time TTL filtering. setTimeout-based hide breaks under browser
// background-tab throttling (OBS overlay running while game is foregrounded).
let flagEventSeq = 0;
let killSeq = 0;
let dmgSeq = 0;

// Depth of the caster page's kill scrollback (store slice `kill_log`). Deep
// enough to cover a full half of a 6v6 for reference, bounded so a long prod
// match can't grow it without limit.
const KILL_LOG_CAP = 150;

// Per-player stat fields streamed by the plugin (player_score extension +
// player_stats_summary rows). Shared so defaults/resets/copies can't drift.
// `best_streak` is special-cased in addStatRows (max, not sum) for match totals.
const STAT_FIELDS = ['damage', 'assists', 'hs_kills', 'nade_kills', 'gun_kills', 'hits', 'hs_hits', 'caps', 'cap_breaks', 'best_streak'];

// True once an authoritative stats board (reason half_end/match_end) was shown
// for the current half boundary — suppresses the snapshot fallback at the next
// half boundary so the board doesn't re-show over live play.
let boundaryBoardShown = false;

// Per-completed-half stat contributions for the cumulative match-end board,
// keyed by half number → { user_id → statRow }. Stored per-half (not eagerly
// summed) so the AUTHORITATIVE half_end/match_end summary can OVERRIDE a
// store-snapshot fallback for the same half. halfSource records which won.
// The plugin emits the half_end marker event slightly before the half_end
// summary on the same socket, so the snapshot would otherwise lock the fold
// first; preferring 'summary' honors the intended authoritative-summary design.
// Reset on half 1 (fresh match).
let halfRows = {};      // { [half]: { [user_id]: statRow } }
let halfSource = {};    // { [half]: 'snapshot' | 'summary' }

// Most recent authoritative per-player snapshot seen for each half, keyed
// half → { user_id → statRow }. round_end (capout) summaries fire on every
// capout carrying ALL connected players with exact cumulative half stats, so
// the last one is the most complete snapshot of that half. Used to (a) back the
// carry fallback when no half_end summary survives the changelevel, and (b)
// recover players who disconnect after the final capout but before match_end
// (the match_end summary only carries still-connected players). Reset on half 1.
let lastRoundEndByHalf = {};   // { [half]: { [user_id]: statRow } }

// The prod plugin emits ktp_match_start AND half_start at every half boundary;
// the mocker emits only half_start after half 1. Boundary work (record carry,
// dismiss/fallback board) must run exactly once per boundary from whichever
// event arrives first.
let boundaryHandledForHalf = null;

// Record a completed half's contribution. A 'summary' source (authoritative
// plugin stats) overrides an earlier 'snapshot' (store-derived fallback) for
// the same half; a 'snapshot' never overrides a 'summary'.
function recordHalf(rows, endingHalf, source) {
    if (endingHalf == null) return;
    if (halfSource[endingHalf] === 'summary' && source !== 'summary') return;
    const byId = {};
    rows.forEach(r => { byId[r.user_id] = r; });
    halfRows[endingHalf] = byId;
    halfSource[endingHalf] = source;
}

// Sum all recorded prior-half contributions by user_id (best_streak takes max
// via addStatRows). Consumed by the match_end board for full-match totals.
export function carrySoFar() {
    const merged = {};
    Object.keys(halfRows).forEach(h => {
        Object.values(halfRows[h]).forEach(r => {
            merged[r.user_id] = merged[r.user_id] ? addStatRows(merged[r.user_id], r) : r;
        });
    });
    return merged;
}

// Read-only accessors over the completed-half archive, for the caster page's
// scope toggle (This Half / H1 / H2 / Match). Deliberately plain getters over
// the module globals rather than store state — mirroring the carry into zustand
// would put the on-air cumulative-stats state machine (guarded by
// Socket.chaos.test.js) on the render path. Callers poll these on their own
// heartbeat; nothing here is reactive.
export function getHalfRows(half) { return halfRows[half] ?? null; }
export function getRecordedHalves() {
    return Object.keys(halfRows).map(Number).sort((a, b) => a - b);
}

function handleHalfBoundary(newHalf) {
    if (newHalf == null || boundaryHandledForHalf === newHalf) return;
    boundaryHandledForHalf = newHalf;

    const { allies_players, axis_players, stats_board, setStatsBoard, half } = useHudStore.getState();
    const preReset = [...allies_players, ...axis_players].map(statRow);

    if (newHalf === 1) {
        // Fresh match — drop carryover and any lingering board.
        halfRows = {};
        halfSource = {};
        lastRoundEndByHalf = {};
        setStatsBoard(null);
    } else if (newHalf >= 2) {
        // Record the completed half's stats. Prefer the last round_end snapshot
        // for that half — the store snapshot is empty here when the changelevel
        // disconnects every player before the boundary fires (player_disconnect
        // splices them out). The authoritative half_end summary, if it arrived,
        // already recorded this half and overrides either via recordHalf's
        // source precedence.
        const retained = Object.values(lastRoundEndByHalf[half] ?? {});
        const carrySnapshot = retained.length ? retained : preReset;
        recordHalf(carrySnapshot, half, 'snapshot');

        if (boundaryBoardShown) {
            // The halftime board ran through warmup — the new half going live
            // dismisses it.
            setStatsBoard(null);
        } else if (carrySnapshot.some(r => r.kills || r.deaths || r.damage)) {
            // Universal fallback: no half_end/match_end signal made it through
            // (lost POST, or the signal-less H2→OT boundary). Show the
            // snapshot; the shorter fallback TTL dismisses it.
            setStatsBoard({
                reason: 'half_end', fallback: true,
                players: carrySnapshot, addedAt: Date.now(),
            });
        }
    } else if (stats_board?.reason === 'round_end') {
        setStatsBoard(null);
    }
    boundaryBoardShown = false;
}

// ─── Zustand Store ────────────────────────────────────────────────────────────

export const useHudStore = create(set => ({

    // Team scores (round wins)
    allies_score: 0,
    axis_score: 0,

    // Current half (1 or 2)
    half: 1,

    // Players keyed by steam ID for fast lookup
    // Each player: { user_id, name, team, class_id, weapon_primary, weapon_secondary,
    //                health, dead, prone_state, prone_since, kills, deaths, score, spectate }
    allies_players: [],
    axis_players:   [],

    // Flag state: [{ flag_id, flag_name, owner, capping_team }]
    flags: [],

    // Kill feed entries — capped at 6 for the on-air overlay (see addKill).
    kills: [],

    // Longer kill history for the caster page's scrollback. Same entries as
    // `kills`, just a deeper cap. The overlay never selects this slice, so
    // zustand's selector subscriptions keep it off /screen's render path.
    kill_log: [],

    // Flag-event feed entries (captures + cap breaks), shown under the flags bar
    flag_feed: [],

    // Kill streaks: { [user_id]: number } — consecutive kills without dying (resets on death/round)
    kill_streaks: {},

    // Full stats board: null | { reason, fallback, players, addedAt }
    // reason: round_end (capout) | half_end | match_end | manual — TTL varies by reason
    stats_board: null,

    // Chat messages: [{ user_id, name, team, team_only, message, timestamp }]
    chat: [],

    // Round state
    round_state: {
        round_end:    false,
        round_freeze: false,
        round_start:  false,
    },

    // Half countdown timer (seconds remaining + browser timestamp of last sync)
    timeleft:    null,
    timeleft_at: null,

    // ── Actions ──────────────────────────────────────────────────────────────

    setAlliesScore: (n) => set({ allies_score: n }),
    setAxisScore:   (n) => set({ axis_score: n }),
    setHalf:        (n) => set({ half: n }),
    setTimeleft:    (seconds) => set({ timeleft: seconds, timeleft_at: Date.now() }),

    setAlliesPlayers: (updater) => set(state => ({
        allies_players: typeof updater === 'function' ? updater(state.allies_players) : [...updater],
    })),
    setAxisPlayers: (updater) => set(state => ({
        axis_players: typeof updater === 'function' ? updater(state.axis_players) : [...updater],
    })),

    setFlags: (flags) => set({ flags: [...flags] }),

    addKill: (kill) => set(state => {
        const streaks = { ...state.kill_streaks };
        // Increment killer's streak (only for normal kills, not suicides/teamkills)
        if (kill.kill_type === 'normal') {
            streaks[kill.killer_id] = (streaks[kill.killer_id] || 0) + 1;
        }
        // Reset victim's streak
        streaks[kill.victim_id] = 0;
        // Cap at 6 — visual limit, oldest evicted when a 7th arrives. Was
        // unbounded; observed 715+ kills in one prod match, and inactive-tab
        // OBS overlays couldn't auto-hide via setTimeout, so the entire history
        // would render at once on refocus.
        const entry = {
            ...kill,
            streak: streaks[kill.killer_id] || 0,
            id: ++killSeq,
            addedAt: Date.now(),
        };
        return {
            kills: [...state.kills.slice(-5), entry],
            // Deeper cap for the caster page's scrollback — bounded for the same
            // reason `kills` is (a 715-kill match must not accumulate forever).
            kill_log: [...state.kill_log.slice(-(KILL_LOG_CAP - 1)), entry],
            kill_streaks: streaks,
        };
    }),
    addChat: (msg)  => set(state => ({ chat: [...state.chat.slice(-19), msg] })),

    // Cap at 3 — visual limit, oldest evicted when a 4th arrives.
    addFlagEvent: (entry) => set(state => ({
        flag_feed: [...state.flag_feed.slice(-2), {
            ...entry,
            id: ++flagEventSeq,
            addedAt: Date.now(),
        }],
    })),

    setRoundState: (info) => set({ round_state: { ...info } }),

    setStatsBoard: (board) => set({ stats_board: board }),

    // Reset kill streaks (on round start)
    resetStreaks: () => set({ kill_streaks: {} }),

    // Wipe per-player game state at half time (keep roster, reset stats).
    // Team scores deliberately preserved — the match score carries across halves;
    // the plugin re-emits team_score immediately after half_start to seed the
    // correct cumulative value (carryover for half 2/OT, 0/0 for half 1).
    // stats_board deliberately survives both resets — boards shown at a half
    // boundary must persist into the next half's warmup; dismissal is handled
    // explicitly in the ktp_match_start handler + render-time TTL.
    resetHalf: () => set(state => {
        const wipe = p => ({
            ...p, health: 100, dead: false, prone_state: 'standing', prone_since: null,
            kills: 0, deaths: 0, score: 0, obj_score: 0,
            damage: 0, assists: 0, hs_kills: 0, nade_kills: 0, gun_kills: 0, hits: 0, hs_hits: 0,
            caps: 0, cap_breaks: 0, best_streak: 0,
            weapon_primary: null, weapon_secondary: null, class_id: null,
            weapon_active: null, nades: null, last_damage: null, last_damage_at: null,
        });
        return {
            kills: [],
            kill_log: [],
            flag_feed: [],
            chat: [],
            kill_streaks: {},
            timeleft: null,
            timeleft_at: null,
            allies_players: state.allies_players.map(wipe),
            axis_players: state.axis_players.map(wipe),
        };
    }),

    // Hard reset on a brand-new match. Clears player arrays so the plugin's
    // roster dump rebuilds them from scratch — kills any stale ghosts left
    // over from the previous match. Scores zero only on half=1 (fresh match);
    // half=2 / OT preserve carryover.
    resetMatch: (half) => set(() => ({
        kills: [],
        kill_log: [],
        flag_feed: [],
        chat: [],
        kill_streaks: {},
        allies_players: [],
        axis_players: [],
        flags: [],
        timeleft: null,
        timeleft_at: null,
        round_state: { round_end: false, round_freeze: false, round_start: false },
        ...(half === 1 ? { allies_score: 0, axis_score: 0 } : {}),
    })),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDefaultPlayer(user_id, name, team) {
    return {
        user_id,
        name,
        team,
        class_id:         null,
        weapon_primary:   null,
        weapon_secondary: null,
        weapon_active:    null,   // live held weapon (Phase 1: weapon_active event)
        nades:            null,   // live grenade count  (Phase 2: player_state snapshot)
        last_damage:      null,   // most recent hit amount (the -N damage popup)
        last_damage_at:   null,   // browser ts of that hit (render-time TTL)
        last_damage_id:   0,      // stable key so the popup re-animates per hit
        health:           100,
        dead:             false,

        prone_state:      'standing',
        prone_since:      null,
        kills:            0,
        deaths:           0,
        score:            0,
        obj_score:        0,
        damage:           0,
        assists:          0,
        hs_kills:         0,
        nade_kills:       0,
        gun_kills:        0,
        hits:             0,
        hs_hits:          0,
        caps:             0,
        cap_breaks:       0,
        best_streak:      0,
        spectate:         false,
    };
}

// Snapshot the stat row a popup/board needs from a live store player.
export function statRow(p) {
    const row = {
        user_id: p.user_id, name: p.name, team: p.team,
        kills: p.kills ?? 0, deaths: p.deaths ?? 0, obj_score: p.obj_score ?? 0,
    };
    STAT_FIELDS.forEach(f => { row[f] = p[f] ?? 0; });
    return row;
}

// Combine b's stats into a (both statRow-shaped); used for cumulative match-end
// totals across halves. Additive fields sum; best_streak takes the max (a
// streak doesn't carry across the half boundary).
export function addStatRows(a, b) {
    const out = { ...a, name: b.name ?? a.name, team: b.team ?? a.team };
    ['kills', 'deaths', 'obj_score', ...STAT_FIELDS].forEach(f => {
        if (f === 'best_streak') {
            out[f] = Math.max(a[f] ?? 0, b[f] ?? 0);
        } else {
            out[f] = (a[f] ?? 0) + (b[f] ?? 0);
        }
    });
    return out;
}

function updatePlayer(players, user_id, updater) {
    const idx = players.findIndex(p => p.user_id === user_id);
    if (idx === -1) return players;
    const next = [...players];
    next[idx] = { ...next[idx], ...updater(next[idx]) };
    return next;
}

// ─── Socket Event Component ───────────────────────────────────────────────────

export const SocketStoreComponent = () => {

    const setAlliesPlayers = useHudStore(s => s.setAlliesPlayers);
    const setAxisPlayers   = useHudStore(s => s.setAxisPlayers);
    const setFlags         = useHudStore(s => s.setFlags);
    const addKill          = useHudStore(s => s.addKill);
    const addChat          = useHudStore(s => s.addChat);
    const addFlagEvent     = useHudStore(s => s.addFlagEvent);
    const setAlliesScore   = useHudStore(s => s.setAlliesScore);
    const setAxisScore     = useHudStore(s => s.setAxisScore);
    const setHalf          = useHudStore(s => s.setHalf);
    const setRoundState    = useHudStore(s => s.setRoundState);
    const setTimeleft      = useHudStore(s => s.setTimeleft);
    const resetHalf        = useHudStore(s => s.resetHalf);
    const resetMatch       = useHudStore(s => s.resetMatch);
    const resetStreaks     = useHudStore(s => s.resetStreaks);

    // Use refs via store getState() for event handlers to avoid stale closures
    const getState = useHudStore.getState;

    useEffect(() => {

        // ── Player connect / disconnect ───────────────────────────────────────

        gameEvents.on('player_connect', (raw) => {
            const e = JSON.parse(raw);
            playerDirectory[e.user_id] = { name: e.name, team: e.team };
            const player = makeDefaultPlayer(e.user_id, e.name, e.team);

            // Reconnect path: keep the existing record (preserves class/weapons/
            // score) but refresh name+team. The plugin reuses user_id across
            // reconnects, and dproto can keep the same fake-id through an in-game
            // rename — so a stale name would otherwise stick on the HUD.
            const upsert = (prev) => {
                const idx = prev.findIndex(p => p.user_id === e.user_id);
                if (idx === -1) return [...prev, player];
                const cur = prev[idx];
                if (cur.name === e.name && cur.team === e.team) return prev;
                const next = [...prev];
                next[idx] = { ...cur, name: e.name, team: e.team };
                return next;
            };

            if (e.team === 'allies') {
                setAxisPlayers(prev => prev.filter(p => p.user_id !== e.user_id));
                setAlliesPlayers(upsert);
            } else if (e.team === 'axis') {
                setAlliesPlayers(prev => prev.filter(p => p.user_id !== e.user_id));
                setAxisPlayers(upsert);
            }
        });

        gameEvents.on('player_disconnect', (raw) => {
            const e = JSON.parse(raw);
            setAlliesPlayers(prev => prev.filter(p => p.user_id !== e.user_id));
            setAxisPlayers(prev => prev.filter(p => p.user_id !== e.user_id));
        });

        gameEvents.on('player_team_change', (raw) => {
            const e = JSON.parse(raw);
            if (playerDirectory[e.user_id]) playerDirectory[e.user_id].team = e.team;
            const { allies_players, axis_players } = getState();
            // Move player to correct team array
            const fromAllies = allies_players.find(p => p.user_id === e.user_id);
            const fromAxis   = axis_players.find(p => p.user_id === e.user_id);

            if (e.team === 'allies' && fromAxis) {
                setAxisPlayers(axis_players.filter(p => p.user_id !== e.user_id));
                setAlliesPlayers([...allies_players, { ...fromAxis, team: 'allies' }]);
            } else if (e.team === 'axis' && fromAllies) {
                setAlliesPlayers(allies_players.filter(p => p.user_id !== e.user_id));
                setAxisPlayers([...axis_players, { ...fromAllies, team: 'axis' }]);
            }
        });


        // ── Spawn ─────────────────────────────────────────────────────────────

        gameEvents.on('player_spawn', (raw) => {
            const e = JSON.parse(raw);
            const dir = playerDirectory[e.user_id];
            if (dir) {
                dir.team = e.team;
                if (e.name) dir.name = e.name;
            } else {
                playerDirectory[e.user_id] = { name: e.name ?? e.user_id, team: e.team };
            }

            const spawnState = {
                // Include name so an in-game rename (dproto keeps the same fake
                // SteamID through changename) propagates onto the HUD instead
                // of being trapped in playerDirectory.
                ...(e.name ? { name: e.name } : {}),
                class_id:         e.class_id,
                weapon_primary:   e.weapon_primary,
                weapon_secondary: e.weapon_secondary,
                weapon_active:    null,  // re-populated by first weapon_active switch
                nades:            null,  // re-populated by player_state snapshot
                last_damage:      null,
                last_damage_at:   null,
                health:           e.health ?? 100,
                dead:             false,

                prone_state:      'standing',
                prone_since:      null,
                disconnected:     false,
            };

            const applySpawn = (prev, team) => {
                const exists = prev.find(p => p.user_id === e.user_id);
                if (exists) return updatePlayer(prev, e.user_id, () => spawnState);
                const knownName = playerDirectory[e.user_id]?.name ?? e.user_id;
                return [...prev, { ...makeDefaultPlayer(e.user_id, knownName, team), ...spawnState }];
            };

            if (e.team === 'allies') {
                setAxisPlayers(prev => prev.filter(p => p.user_id !== e.user_id));
                setAlliesPlayers(prev => applySpawn(prev, 'allies'));
            } else if (e.team === 'axis') {
                setAlliesPlayers(prev => prev.filter(p => p.user_id !== e.user_id));
                setAxisPlayers(prev => applySpawn(prev, 'axis'));
            }
        });


        // ── Kill ──────────────────────────────────────────────────────────────

        gameEvents.on('kill', (raw) => {
            const e = JSON.parse(raw);
            const { allies_players, axis_players } = getState();

            // Resolve names for kill feed — try team arrays first, fall back to persistent directory
            const allPlayers = [...allies_players, ...axis_players];
            const killer = allPlayers.find(p => p.user_id === e.killer_id)
                ?? playerDirectory[e.killer_id]
                ?? { name: e.killer_id, team: 'unknown' };
            const victim = allPlayers.find(p => p.user_id === e.victim_id)
                ?? playerDirectory[e.victim_id]
                ?? { name: e.victim_id, team: 'unknown' };

            // Assister names for the kill feed (50+ damage, attributed by the plugin)
            const assisters = (e.assist_ids || []).map(id =>
                allPlayers.find(p => p.user_id === id)
                ?? playerDirectory[id]
                ?? { name: id, team: killer.team }
            );

            addKill({ ...e, killer, victim, assisters });

            // Mark victim dead, clear prone shame + live weapon/nades
            const deadState = { health: 0, dead: true, prone_state: 'standing', prone_since: null,
                weapon_active: null, nades: null, last_damage: null, last_damage_at: null };
            setAlliesPlayers(prev => updatePlayer(prev, e.victim_id, () => deadState));
            setAxisPlayers(prev => updatePlayer(prev, e.victim_id, () => deadState));
        });


        // ── Damage ────────────────────────────────────────────────────────────

        gameEvents.on('damage', (raw) => {
            const e = JSON.parse(raw);
            const id = ++dmgSeq;
            const healthUpdate = () => ({
                health: Math.max(0, e.victim_health),
                last_damage: e.damage,
                last_damage_at: Date.now(),
                last_damage_id: id,
            });
            setAlliesPlayers(prev => updatePlayer(prev, e.victim_id, healthUpdate));
            setAxisPlayers(prev => updatePlayer(prev, e.victim_id, healthUpdate));
        });


        // ── Prone ─────────────────────────────────────────────────────────────

        gameEvents.on('prone_change', (raw) => {
            const e = JSON.parse(raw);
            const proneUpdate = () => ({
                prone_state: e.state,
                // Anchor on the client RECEIPT instant, not the plugin's server
                // timestamp (e.timestamp). The event is delay-buffered ~60s, so
                // receipt ≈ the broadcast instant the player went prone — making the
                // shame timer broadcast-relative. e.timestamp would inflate it by the
                // full delay plus any server↔browser clock skew (clocks not NTP-locked).
                prone_since: e.state !== 'standing' ? Date.now() : null,
            });
            setAlliesPlayers(prev => updatePlayer(prev, e.user_id, proneUpdate));
            setAxisPlayers(prev => updatePlayer(prev, e.user_id, proneUpdate));
        });


        // ── Weapon active (live held weapon) ─────────────────────────────────

        gameEvents.on('weapon_active', (raw) => {
            const e = JSON.parse(raw);
            const wpnUpdate = () => ({ weapon_active: e.weapon });
            setAlliesPlayers(prev => updatePlayer(prev, e.user_id, wpnUpdate));
            setAxisPlayers(prev => updatePlayer(prev, e.user_id, wpnUpdate));
        });


        // ── Live player-state snapshot (4 Hz batched) ────────────────────────
        // Owns weapon_active / nades only. Health stays owned by the precise
        // damage/kill events (a 250ms-stale snapshot must not override a fresh
        // hit), and prone stays owned by prone_change (it carries the shame
        // timestamp). Players absent from the array (dead/disconnected) are left
        // untouched — the kill/disconnect handlers already cleared them.

        gameEvents.on('player_state', (raw) => {
            const e = JSON.parse(raw);
            if (!Array.isArray(e.players)) return;
            const byId = {};
            e.players.forEach(p => { byId[p.user_id] = p; });
            const apply = (prev) => prev.map(pl => {
                const s = byId[pl.user_id];
                if (!s) return pl;
                return {
                    ...pl,
                    weapon_active: s.weapon ? s.weapon : null,
                    nades: s.nades,
                };
            });
            setAlliesPlayers(apply);
            setAxisPlayers(apply);
        });


        // ── Weapon pickup / drop ─────────────────────────────────────────────

        gameEvents.on('weapon_pickup', (raw) => {
            const e = JSON.parse(raw);
            const wpnUpdate = () => ({ weapon_primary: e.weapon });
            setAlliesPlayers(prev => updatePlayer(prev, e.user_id, wpnUpdate));
            setAxisPlayers(prev => updatePlayer(prev, e.user_id, wpnUpdate));
        });

        gameEvents.on('weapon_drop', (raw) => {
            const e = JSON.parse(raw);
            setAlliesPlayers(prev => updatePlayer(prev, e.user_id, (p) =>
                p.weapon_primary === e.weapon ? { weapon_primary: null } : {}
            ));
            setAxisPlayers(prev => updatePlayer(prev, e.user_id, (p) =>
                p.weapon_primary === e.weapon ? { weapon_primary: null } : {}
            ));
        });


        // ── Grenade throw ────────────────────────────────────────────────────

        gameEvents.on('nade_throw', (raw) => {
            const e = JSON.parse(raw);
            setAlliesPlayers(prev => updatePlayer(prev, e.user_id, (p) => ({
                nades_thrown: (p.nades_thrown || 0) + 1,
            })));
            setAxisPlayers(prev => updatePlayer(prev, e.user_id, (p) => ({
                nades_thrown: (p.nades_thrown || 0) + 1,
            })));
        });


        // ── Chat ─────────────────────────────────────────────────────────────

        gameEvents.on('user_say', (raw) => {
            const e = JSON.parse(raw);
            const { allies_players, axis_players } = getState();
            const allPlayers = [...allies_players, ...axis_players];
            const sender = allPlayers.find(p => p.user_id === e.user_id) ?? playerDirectory[e.user_id];
            addChat({
                user_id: e.user_id,
                name: sender?.name ?? e.user_id,
                team: sender?.team ?? 'unknown',
                team_only: e.team_only,
                message: e.message,
                timestamp: Date.now(),
            });
        });


        // ── Score ─────────────────────────────────────────────────────────────

        gameEvents.on('player_score', (raw) => {
            const e = JSON.parse(raw);
            const scoreUpdate = () => {
                const update = {
                    kills: e.kills, deaths: e.deaths,
                    score: e.score, obj_score: e.obj_score ?? 0,
                };
                // Stat fields absent from old-plugin events default to 0.
                STAT_FIELDS.forEach(f => { update[f] = e[f] ?? 0; });
                return update;
            };
            setAlliesPlayers(prev => updatePlayer(prev, e.user_id, scoreUpdate));
            setAxisPlayers(prev => updatePlayer(prev, e.user_id, scoreUpdate));
        });

        // ── Stats summary / boards ────────────────────────────────────────────

        // Batched per-player stats from the plugin at discrete boundaries
        // (cap / round end / half end / match end / rcon amx_hud_statsboard).
        // Always merge stats into the team arrays; board-worthy reasons also
        // set the centered stats board.
        gameEvents.on('player_stats_summary', (raw) => {
            const e = JSON.parse(raw);
            const rows = e.players ?? [];
            const byId = {};
            rows.forEach(r => { byId[r.user_id] = r; });

            const apply = prev => prev.map(pl => {
                const r = byId[pl.user_id];
                if (!r) return pl;
                const update = {
                    kills: r.kills ?? pl.kills,
                    deaths: r.deaths ?? pl.deaths,
                    obj_score: r.obj_score ?? pl.obj_score,
                };
                STAT_FIELDS.forEach(f => { update[f] = r[f] ?? 0; });
                return { ...pl, ...update };
            });
            setAlliesPlayers(apply);
            setAxisPlayers(apply);

            if (e.reason === 'half_end') {
                boundaryBoardShown = true;
                // Authoritative — overrides any store-snapshot fold for this half.
                recordHalf(rows.map(r => statRow(r)), useHudStore.getState().half, 'summary');
                useHudStore.getState().setStatsBoard({
                    reason: 'half_end', players: rows.map(r => statRow(r)), addedAt: Date.now(),
                });
            } else if (e.reason === 'match_end') {
                // Full-match totals: recorded prior halves (carrySoFar) + this
                // (final) half's contribution. The final half starts from the last
                // round_end snapshot (every connected player at the last capout)
                // overlaid by the match_end rows (authoritative for still-connected
                // players) — this recovers players who disconnected after the final
                // capout but before match_end, which the connected-only match_end
                // summary drops. OT caveat: no summary fires at the H2→OT boundary,
                // so OT matches sum whatever boundary snapshots were recorded.
                boundaryBoardShown = true;
                const merged = carrySoFar();
                const curHalf = useHudStore.getState().half;
                const finalHalf = { ...(lastRoundEndByHalf[curHalf] ?? {}) };
                rows.forEach(r => { finalHalf[r.user_id] = statRow(r); });
                Object.values(finalHalf).forEach(r => {
                    merged[r.user_id] = merged[r.user_id]
                        ? addStatRows(merged[r.user_id], r)
                        : r;
                });
                useHudStore.getState().setStatsBoard({
                    reason: 'match_end', players: Object.values(merged), addedAt: Date.now(),
                });
            } else if (e.reason === 'round_end' || e.reason === 'manual') {
                // round_end fires on a full capout — the cumulative capout board.
                // capout_team/capout_by title it "ALLIES CAPOUT BY <names>".
                const boardRows = rows.map(r => statRow(r));
                if (e.reason === 'round_end') {
                    // Retain this half's most complete snapshot — it carries every
                    // connected player's cumulative half stats. Recovers the lost
                    // half-1 carry and any player who leaves before match_end.
                    const snap = {};
                    boardRows.forEach(r => { snap[r.user_id] = r; });
                    lastRoundEndByHalf[useHudStore.getState().half] = snap;
                }
                useHudStore.getState().setStatsBoard({
                    reason: e.reason, players: boardRows, addedAt: Date.now(),
                    capout_team: e.capout_team ?? null, capout_by: e.capout_by ?? null,
                });
            }
        });

        // Best-effort half-end marker from the plugin (KTP_HALF_END log line).
        // The summary normally lands in the same instant and overwrites this
        // store-derived board; if the half_end POST is the only survivor of the
        // changelevel, this still auto-shows the halftime board.
        gameEvents.on('half_end', () => {
            const { allies_players, axis_players, stats_board, setStatsBoard, half } = getState();
            const storeRows = [...allies_players, ...axis_players].map(statRow);
            // Prefer the last round_end snapshot when the store is empty (the
            // changelevel can splice every player before this marker arrives).
            const retained = Object.values(lastRoundEndByHalf[half] ?? {});
            const players = storeRows.length ? storeRows : retained;
            if (players.length === 0) return;
            // Snapshot fallback for the carry — the authoritative summary, if it
            // arrives, overrides this via recordHalf's source precedence.
            recordHalf(players, half, 'snapshot');
            // The two POSTs (half_end + summary) can arrive in either order —
            // never clobber an authoritative board that just landed.
            if (stats_board?.reason === 'half_end' && Date.now() - stats_board.addedAt < 5000) return;
            boundaryBoardShown = true;
            setStatsBoard({ reason: 'half_end', players, addedAt: Date.now() });
        });

        gameEvents.on('team_score', (raw) => {
            const e = JSON.parse(raw);
            setAlliesScore(e.allies_score);
            setAxisScore(e.axis_score);
        });


        // ── Round ─────────────────────────────────────────────────────────────

        gameEvents.on('round_start_freeze', () => {
            setRoundState({ round_end: false, round_freeze: true, round_start: false });
        });

        gameEvents.on('round_start', (raw) => {
            const e = typeof raw === 'string' ? JSON.parse(raw) : {};
            if (e.timeleft != null) setTimeleft(e.timeleft);
            setRoundState({ round_end: false, round_freeze: false, round_start: true });
            resetStreaks();

            // A new live round dismisses any round-end mini board early.
            const { stats_board, setStatsBoard } = getState();
            if (stats_board?.reason === 'round_end') setStatsBoard(null);
        });

        gameEvents.on('round_end', (raw) => {
            const e = JSON.parse(raw);
            setAlliesScore(e.allies_score);
            setAxisScore(e.axis_score);
            setRoundState({ round_end: true, round_freeze: false, round_start: false });

            // Revive all players 5s after round end (for scoreboard display)
            setTimeout(() => {
                const { allies_players, axis_players } = getState();
                const revive = players => players.map(p => ({
                    ...p, dead: false, health: 100, prone_state: 'standing', prone_since: null,
                }));
                setAlliesPlayers(revive(allies_players));
                setAxisPlayers(revive(axis_players));
            }, 5000);
        });

        gameEvents.on('half_start', (raw) => {
            const e = JSON.parse(raw);
            // Boundary bookkeeping (no-op when ktp_match_start already ran it).
            handleHalfBoundary(e.half);
            setHalf(e.half);
            resetHalf();
            if (e.timeleft != null) setTimeleft(e.timeleft);
            setRoundState({ round_end: false, round_freeze: false, round_start: false });
        });

        // Fired by KTPMatchHandler when a match begins (incl. half 2 and OT).
        // Clears player arrays so the plugin's roster dump rebuilds them with
        // current alive/dead/health state — eliminates stale ghosts and the
        // race where do_roster_dump runs while a player is still spawn-pending.
        gameEvents.on('ktp_match_start', (raw) => {
            const e = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {});
            // Boundary bookkeeping runs BEFORE resetMatch wipes stats.
            handleHalfBoundary(e.half);
            resetMatch(e.half);
            if (e.half != null) setHalf(e.half);
        });

        // Snapshot row from the plugin's do_roster_dump or backend snapshot
        // replay. Carries alive/dead, class, weapons, current health, prone.
        // Distinct from player_spawn (which means "just respawned at 100 HP").
        gameEvents.on('roster_player', (raw) => {
            const e = JSON.parse(raw);
            const dir = playerDirectory[e.user_id];
            if (dir) {
                dir.team = e.team;
                if (e.name) dir.name = e.name;
            } else {
                playerDirectory[e.user_id] = { name: e.name ?? e.user_id, team: e.team };
            }

            const rosterState = {
                // Same rename-propagation reason as player_spawn.
                ...(e.name ? { name: e.name } : {}),
                class_id:         e.alive ? e.class_id : null,
                weapon_primary:   e.alive ? e.weapon_primary : null,
                weapon_secondary: e.alive ? e.weapon_secondary : null,
                health:           e.health ?? (e.alive ? 100 : 0),
                dead:             !e.alive,
                prone_state:      e.prone_state ?? 'standing',
                // Snapshot replay: the cached prone_since is the old server timestamp
                // and isn't broadcast-relative. Re-anchor on receipt so the shame
                // timer restarts from ~0 on reload (bounded, acceptable) rather than
                // showing an inflated elapsed.
                prone_since:      (e.prone_state && e.prone_state !== 'standing') ? Date.now() : null,
                disconnected:     false,
            };

            const applyRoster = (prev, team) => {
                const exists = prev.find(p => p.user_id === e.user_id);
                if (exists) return updatePlayer(prev, e.user_id, () => rosterState);
                const knownName = playerDirectory[e.user_id]?.name ?? e.user_id;
                return [...prev, { ...makeDefaultPlayer(e.user_id, knownName, team), ...rosterState }];
            };

            if (e.team === 'allies') {
                setAxisPlayers(prev => prev.filter(p => p.user_id !== e.user_id));
                setAlliesPlayers(prev => applyRoster(prev, 'allies'));
            } else if (e.team === 'axis') {
                setAlliesPlayers(prev => prev.filter(p => p.user_id !== e.user_id));
                setAxisPlayers(prev => applyRoster(prev, 'axis'));
            }
        });


        // ── Time sync ────────────────────────────────────────────────────────

        gameEvents.on('time_sync', (raw) => {
            const e = JSON.parse(raw);
            if (e.timeleft != null) setTimeleft(e.timeleft);
        });


        // ── Flags ─────────────────────────────────────────────────────────────

        gameEvents.on('flags_init', (raw) => {
            const e = JSON.parse(raw);
            const { flags: prior } = getState();
            setFlags(e.flags.map(f => {
                // Preserve a non-neutral owner against a neutral snapshot. The
                // engine resets every flag to TEAM_SPECTATOR during round-restart
                // windows (e.g. last minute before half-time), and the 30s
                // task_emit_flags tick would otherwise wipe the HUD bar to grey.
                // flag_captured remains the source of truth for owner; ktp_match_start
                // clears flags so a fresh half/match still adopts neutrals correctly.
                const before = prior.find(p => p.flag_id === f.flag_id);
                const owner = (before && before.owner !== 'neutral' && f.owner === 'neutral')
                    ? before.owner
                    : f.owner;
                return {
                    ...f, owner,
                    capping_team: null, captor_ids: [], contested: false, progress: 0,
                    allies_count: 0, axis_count: 0,
                };
            }));
        });

        gameEvents.on('flag_cap_started', (raw) => {
            const e = JSON.parse(raw);
            const { flags } = getState();
            setFlags(flags.map(f =>
                f.flag_id === e.flag_id ? { ...f, capping_team: e.capping_team, captor_ids: e.captor_ids || [] } : f
            ));
        });

        gameEvents.on('flag_cap_stopped', (raw) => {
            const e = JSON.parse(raw);
            const { flags } = getState();
            setFlags(flags.map(f =>
                f.flag_id === e.flag_id ? { ...f, capping_team: null, captor_ids: [], progress: 0, contested: false, allies_count: 0, axis_count: 0 } : f
            ));
        });

        gameEvents.on('flag_captured', (raw) => {
            const e = JSON.parse(raw);
            const { flags, allies_players, axis_players } = getState();
            setFlags(flags.map(f =>
                f.flag_id === e.flag_id
                    ? { ...f, owner: e.new_owner, capping_team: null, captor_ids: [], progress: 0, contested: false, allies_count: 0, axis_count: 0 }
                    : f
            ));

            // Capture kill feed entry with real captor attribution from dod_score_event.
            // Fall back to the raw steam id + capturing team when a captor isn't in
            // the roster yet (late join / pre-connect), mirroring the kill-feed
            // resolver — otherwise .filter(Boolean) would silently drop the name and
            // the feed would show a nameless cap. captor_ids now arrive populated
            // (plugin defers flag_captured until dod_score_event fills the batch).
            const allPlayers = [...allies_players, ...axis_players];
            const captors = (e.captor_ids || []).map(id =>
                allPlayers.find(p => p.user_id === id) ?? playerDirectory[id] ?? { name: id, team: e.new_owner }
            ).filter(Boolean);

            // The flag feed announces every cap. Cumulative per-player stats are
            // shown on the capout board (round_end summary), not per single cap.
            addFlagEvent({
                kind: 'captured',
                flag_name: e.flag_name,
                flag_id: e.flag_id,
                new_owner: e.new_owner,
                captors,
            });
        });

        gameEvents.on('flag_zone_players', (raw) => {
            const e = JSON.parse(raw);
            const { flags } = getState();
            setFlags(flags.map(f => {
                const zone = e.zones.find(z => z.flag_id === f.flag_id);
                if (!zone) return f;
                // Accept either count fields (production plugin) or id arrays (mocker fixtures).
                const raw_allies = zone.allies_count ?? (zone.allies_ids?.length ?? 0);
                const raw_axis   = zone.axis_count   ?? (zone.axis_ids?.length   ?? 0);
                const allies_numcap = zone.allies_numcap ?? f.allies_numcap ?? 1;
                const axis_numcap   = zone.axis_numcap   ?? f.axis_numcap   ?? 1;

                // Engine zone counts pulse on touch ticks — the same player can
                // appear/disappear between polls. While a team is actively capping,
                // hold the displayed count at the rolling max so the badge doesn't
                // flicker. Reset on cap end (handled in cap_started/stopped/captured).
                let allies_count = raw_allies;
                let axis_count   = raw_axis;
                if (f.capping_team === 'allies') {
                    allies_count = Math.max(raw_allies, f.allies_count || 0);
                } else if (f.capping_team === 'axis') {
                    axis_count = Math.max(raw_axis, f.axis_count || 0);
                }

                return { ...f, allies_count, axis_count, allies_numcap, axis_numcap };
            }));
        });

        gameEvents.on('flag_cap_contested', (raw) => {
            const e = JSON.parse(raw);
            const { flags } = getState();
            setFlags(flags.map(f =>
                f.flag_id === e.flag_id ? { ...f, contested: true } : f
            ));

            addFlagEvent({
                kind: 'cap_break',
                flag_name: e.flag_name,
                flag_id: e.flag_id,
                contesting_team: e.contesting_team,
                contester_count: e.contester_count ?? (e.contester_ids?.length ?? 0),
            });
        });

        gameEvents.on('flag_cap_progress', (raw) => {
            const e = JSON.parse(raw);
            const { flags } = getState();
            setFlags(flags.map(f =>
                f.flag_id === e.flag_id
                    ? { ...f, progress: e.progress, capping_team: e.capping_team, contested: false }
                    : f
            ));
        });

        // Kill-attributed cap break: an enemy killed a capper on the point. The
        // cap_breaks stat is credited via the breaker's player_score; this feed
        // entry surfaces the live defensive play with the breaker's name. The
        // breaker is on the team opposite broke_team.
        gameEvents.on('cap_break', (raw) => {
            const e = JSON.parse(raw);
            const { allies_players, axis_players } = getState();
            const allPlayers = [...allies_players, ...axis_players];
            const breaker = allPlayers.find(p => p.user_id === e.breaker_id)
                ?? playerDirectory[e.breaker_id]
                ?? { name: e.breaker_id };
            addFlagEvent({
                kind: 'cap_break_kill',
                flag_name: e.flag_name,
                flag_id: e.flag_id,
                breaker_name: breaker.name,
                breaker_team: breaker.team ?? (e.broke_team === 'allies' ? 'axis' : 'allies'),
                broke_team: e.broke_team,
            });
        });


        // ── Caster observed ───────────────────────────────────────────────────
        // Disabled: the plugin's amx_dod_observe rcon emits caster_observed_player,
        // but nothing in prod calls it — no auto-detection of the caster's HLTV
        // spectate target exists yet. Re-enable when an automatic source is wired up.
        // gameEvents.on('caster_observed_player', (raw) => {
        //     const e = JSON.parse(raw);
        //     setAlliesPlayers(prev => prev.map(p => ({ ...p, spectate: p.user_id === e.user_id })));
        //     setAxisPlayers(prev => prev.map(p => ({ ...p, spectate: p.user_id === e.user_id })));
        // });


        return () => gameEvents.removeAllListeners();

    }, []);  // empty deps — we read state via getState() to avoid stale closures

    return null;
};
