import React, { useEffect } from 'react';
import socketio from 'socket.io-client';
import create from 'zustand';
import gameEvents from '../gameEvents';

const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || 'http://localhost:4000';
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

    // Kill feed entries
    kills: [],

    // Flag-event feed entries (captures + cap breaks), shown under the flags bar
    flag_feed: [],

    // Kill streaks: { [user_id]: number } — consecutive kills without dying (resets on death/round)
    kill_streaks: {},

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
        return {
            kills: [...state.kills, { ...kill, streak: streaks[kill.killer_id] || 0 }],
            kill_streaks: streaks,
        };
    }),
    addChat: (msg)  => set(state => ({ chat: [...state.chat.slice(-19), msg] })),

    addFlagEvent: (entry) => set(state => ({
        flag_feed: [...state.flag_feed.slice(-9), { ...entry, id: state.flag_feed.length }],
    })),

    setRoundState: (info) => set({ round_state: { ...info } }),

    // Reset kill streaks (on round start)
    resetStreaks: () => set({ kill_streaks: {} }),

    // Wipe per-player game state at half time (keep roster, reset stats)
    resetHalf: () => set(state => ({
        kills: [],
        flag_feed: [],
        chat: [],
        kill_streaks: {},
        allies_score: 0,
        axis_score: 0,
        timeleft: null,
        timeleft_at: null,
        allies_players: state.allies_players.map(p => ({
            ...p, health: 100, dead: false, prone_state: 'standing', prone_since: null,
            kills: 0, deaths: 0, score: 0,
            weapon_primary: null, weapon_secondary: null, class_id: null,
        })),
        axis_players: state.axis_players.map(p => ({
            ...p, health: 100, dead: false, prone_state: 'standing', prone_since: null,
            kills: 0, deaths: 0, score: 0,
            weapon_primary: null, weapon_secondary: null, class_id: null,
        })),
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
        health:           100,
        dead:             false,

        prone_state:      'standing',
        prone_since:      null,
        kills:            0,
        deaths:           0,
        score:            0,
        spectate:         false,
    };
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
    const resetStreaks     = useHudStore(s => s.resetStreaks);

    // Use refs via store getState() for event handlers to avoid stale closures
    const getState = useHudStore.getState;

    useEffect(() => {

        // ── Player connect / disconnect ───────────────────────────────────────

        gameEvents.on('player_connect', (raw) => {
            const e = JSON.parse(raw);
            playerDirectory[e.user_id] = { name: e.name, team: e.team };
            const player = makeDefaultPlayer(e.user_id, e.name, e.team);

            if (e.team === 'allies') {
                setAxisPlayers(prev => prev.filter(p => p.user_id !== e.user_id));
                setAlliesPlayers(prev => prev.find(p => p.user_id === e.user_id) ? prev : [...prev, player]);
            } else if (e.team === 'axis') {
                setAlliesPlayers(prev => prev.filter(p => p.user_id !== e.user_id));
                setAxisPlayers(prev => prev.find(p => p.user_id === e.user_id) ? prev : [...prev, player]);
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
                class_id:         e.class_id,
                weapon_primary:   e.weapon_primary,
                weapon_secondary: e.weapon_secondary,
                health:           100,
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

            addKill({ ...e, killer, victim });

            // Mark victim dead, clear prone shame
            const deadState = { health: 0, dead: true, prone_state: 'standing', prone_since: null };
            setAlliesPlayers(prev => updatePlayer(prev, e.victim_id, () => deadState));
            setAxisPlayers(prev => updatePlayer(prev, e.victim_id, () => deadState));
        });


        // ── Damage ────────────────────────────────────────────────────────────

        gameEvents.on('damage', (raw) => {
            const e = JSON.parse(raw);
            const healthUpdate = () => ({ health: Math.max(0, e.victim_health) });
            setAlliesPlayers(prev => updatePlayer(prev, e.victim_id, healthUpdate));
            setAxisPlayers(prev => updatePlayer(prev, e.victim_id, healthUpdate));
        });


        // ── Prone ─────────────────────────────────────────────────────────────

        gameEvents.on('prone_change', (raw) => {
            const e = JSON.parse(raw);
            const proneUpdate = () => ({
                prone_state: e.state,
                prone_since: e.state !== 'standing' ? e.timestamp : null,
            });
            setAlliesPlayers(prev => updatePlayer(prev, e.user_id, proneUpdate));
            setAxisPlayers(prev => updatePlayer(prev, e.user_id, proneUpdate));
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
            const scoreUpdate = () => ({ kills: e.kills, deaths: e.deaths, score: e.score });
            setAlliesPlayers(prev => updatePlayer(prev, e.user_id, scoreUpdate));
            setAxisPlayers(prev => updatePlayer(prev, e.user_id, scoreUpdate));
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
            setHalf(e.half);
            resetHalf();
            if (e.timeleft != null) setTimeleft(e.timeleft);
            setRoundState({ round_end: false, round_freeze: false, round_start: false });
        });


        // ── Time sync ────────────────────────────────────────────────────────

        gameEvents.on('time_sync', (raw) => {
            const e = JSON.parse(raw);
            if (e.timeleft != null) setTimeleft(e.timeleft);
        });


        // ── Flags ─────────────────────────────────────────────────────────────

        gameEvents.on('flags_init', (raw) => {
            const e = JSON.parse(raw);
            setFlags(e.flags.map(f => ({
                ...f, capping_team: null, captor_ids: [], contested: false, progress: 0,
                allies_count: 0, axis_count: 0,
            })));
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
            const allPlayers = [...allies_players, ...axis_players];
            const captors = (e.captor_ids || []).map(id =>
                allPlayers.find(p => p.user_id === id) ?? playerDirectory[id]
            ).filter(Boolean);

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


        // ── Caster observed ───────────────────────────────────────────────────

        gameEvents.on('caster_observed_player', (raw) => {
            const e = JSON.parse(raw);
            setAlliesPlayers(prev => prev.map(p => ({ ...p, spectate: p.user_id === e.user_id })));
            setAxisPlayers(prev => prev.map(p => ({ ...p, spectate: p.user_id === e.user_id })));
        });


        return () => gameEvents.removeAllListeners();

    }, []);  // empty deps — we read state via getState() to avoid stale closures

    return null;
};
