/**
 * Frontend store-machine chaos tests
 *
 * The cumulative-stats machine (halfRows / halfSource / recordHalf / carrySoFar
 * / handleHalfBoundary + the half_end-event-vs-summary precedence) is the
 * highest-churn, riskiest code in Socket.jsx and is otherwise only touched by
 * the happy-path Playwright run. These tests drive the REAL event handlers
 * through the shared gameEvents bus (the same path the live socket uses) and
 * assert the boundary state machine survives adversarial 6v6 orderings:
 *   - the half_end marker event arriving before / after its authoritative summary
 *   - a dropped half_end summary (fallback board from the store snapshot)
 *   - match-end totals = recorded prior halves + final half (best_streak MAX'd)
 *   - the prod double-boundary (ktp_match_start AND half_start) counted once
 *   - the signal-less H2→OT boundary
 *   - reconnect + halftime team swap carried by user_id
 *
 * State isolation: Socket.jsx keeps the carry state in module-level globals
 * (halfRows, halfSource, boundaryHandledForHalf, boundaryBoardShown). Rather
 * than jest.resetModules() (which re-runs the module graph and breaks jest's
 * resolution of the root-hoisted zustand → web-local react), each test mounts a
 * fresh component (RTL auto-unmounts between tests, clearing gameEvents
 * handlers) and opens with a half-1 boundary emit, which is exactly what
 * resets those globals + the store in production.
 *
 * socket.io-client is mocked so module load doesn't open a real connection.
 */

/* eslint-disable import/first */
jest.mock('socket.io-client', () => {
    const sock = { on: () => {}, onAny: () => {}, emit: () => {}, connect: () => {}, disconnect: () => {} };
    return { __esModule: true, default: { connect: () => sock, io: () => sock }, connect: () => sock, io: () => sock };
});

import React from 'react';
import { render } from '@testing-library/react';
import { act } from 'react-dom/test-utils';
import { SocketStoreComponent, useHudStore } from './Socket';
import gameEvents from '../gameEvents';

// Mount a fresh component (registers the real handlers via useEffect) and reset
// the module-level carry/boundary state + store the production way: a half-1
// match start. Returns { store, emit } for driving the bus.
function setup() {
    render(React.createElement(SocketStoreComponent));
    const emit = (event, obj) => act(() => { gameEvents.emit(event, JSON.stringify(obj)); });
    emit('ktp_match_start', { event: 'ktp_match_start', half: 1 });
    return { store: useHudStore, emit };
}

// ── 6v6-ish roster drivers ───────────────────────────────────────────────────

function connect(emit, id, name, team) {
    emit('player_connect', { event: 'player_connect', user_id: id, name, team });
}
function score(emit, id, kills, deaths, extra = {}) {
    emit('player_score', {
        event: 'player_score', user_id: id, kills, deaths, score: kills * 3, obj_score: 0, ...extra,
    });
}
function summary(emit, reason, players, extra = {}) {
    emit('player_stats_summary', { event: 'player_stats_summary', reason, players, ...extra });
}
function row(id, name, team, kills, deaths, extra = {}) {
    return {
        user_id: id, name, team, kills, deaths, obj_score: 0,
        damage: 0, assists: 0, hs_kills: 0, nade_kills: 0, gun_kills: 0, hits: 0, hs_hits: 0,
        caps: 0, best_streak: 0, ...extra,
    };
}
function boardPlayer(store, id) {
    return (store.getState().stats_board?.players ?? []).find(p => p.user_id === id);
}

describe('Socket store machine — half/match boundary chaos (6v6)', () => {

    it('half_end summary overrides the store snapshot fold when the marker event arrives FIRST', () => {
        const { store, emit } = setup();
        // Half 1: the store snapshot at the boundary says kills:2, but a kill
        // lands in the same instant so the authoritative half_end summary says
        // kills:3. The summary must win the recorded carry.
        connect(emit, 's1', 'Alpha', 'allies');
        score(emit, 's1', 2, 1);

        emit('half_end', { event: 'half_end', half: 1, allies_score: 1, axis_score: 0 });   // snapshot fold
        summary(emit, 'half_end', [row('s1', 'Alpha', 'allies', 3, 1, { caps: 2 })]);        // authoritative

        emit('half_start', { event: 'half_start', half: 2, timeleft: 1200 });
        connect(emit, 's1', 'Alpha', 'allies');
        score(emit, 's1', 1, 0);
        summary(emit, 'match_end', [row('s1', 'Alpha', 'allies', 1, 0, { caps: 1 })]);

        expect(store.getState().stats_board.reason).toBe('match_end');
        expect(boardPlayer(store, 's1').kills).toBe(4);   // 3 (summary) + 1, NOT 2 + 1
        expect(boardPlayer(store, 's1').caps).toBe(3);
    });

    it('half_end summary still wins when the marker event arrives AFTER it', () => {
        const { store, emit } = setup();
        connect(emit, 's1', 'Alpha', 'allies');
        score(emit, 's1', 2, 1);

        summary(emit, 'half_end', [row('s1', 'Alpha', 'allies', 3, 1)]);                      // authoritative first
        emit('half_end', { event: 'half_end', half: 1, allies_score: 1, axis_score: 0 });     // marker must not clobber

        emit('half_start', { event: 'half_start', half: 2, timeleft: 1200 });
        connect(emit, 's1', 'Alpha', 'allies');
        score(emit, 's1', 1, 0);
        summary(emit, 'match_end', [row('s1', 'Alpha', 'allies', 1, 0)]);

        expect(boardPlayer(store, 's1').kills).toBe(4);   // 3 + 1, not 2 + 1
    });

    it('falls back to the store snapshot board when the half_end summary is dropped entirely', () => {
        const { store, emit } = setup();
        connect(emit, 's1', 'Alpha', 'allies');
        score(emit, 's1', 5, 2, { damage: 300 });

        // No half_end / summary survives the changelevel — only half_start lands.
        emit('half_start', { event: 'half_start', half: 2, timeleft: 1200 });

        const board = store.getState().stats_board;
        expect(board).not.toBeNull();
        expect(board.reason).toBe('half_end');
        expect(board.fallback).toBe(true);
        expect(board.players.find(p => p.user_id === 's1').kills).toBe(5);
    });

    it('match_end totals = recorded prior half + final half, best_streak MAX (not summed)', () => {
        const { store, emit } = setup();
        connect(emit, 's1', 'Alpha', 'allies');
        score(emit, 's1', 3, 1);
        summary(emit, 'half_end', [row('s1', 'Alpha', 'allies', 3, 1, { best_streak: 4, caps: 1, damage: 200 })]);

        emit('half_start', { event: 'half_start', half: 2, timeleft: 1200 });
        connect(emit, 's1', 'Alpha', 'allies');
        summary(emit, 'match_end', [row('s1', 'Alpha', 'allies', 1, 0, { best_streak: 2, caps: 2, damage: 90 })]);

        const p = boardPlayer(store, 's1');
        expect(p.kills).toBe(4);          // 3 + 1
        expect(p.caps).toBe(3);           // 1 + 2
        expect(p.damage).toBe(290);       // 200 + 90
        expect(p.best_streak).toBe(4);    // max(4, 2) — a streak does not carry across halves
    });

    it('shows a fallback board at the signal-less H2 → OT boundary (half 101)', () => {
        const { store, emit } = setup();
        connect(emit, 's1', 'Alpha', 'allies');
        score(emit, 's1', 4, 3, { damage: 250 });

        emit('half_start', { event: 'half_start', half: 101, timeleft: 300 });   // OT entry, no end signal

        const board = store.getState().stats_board;
        expect(board).not.toBeNull();
        expect(board.fallback).toBe(true);
        expect(store.getState().half).toBe(101);
    });

    it('counts the half-1 carry ONCE when prod fires both ktp_match_start and half_start for half 2', () => {
        const { store, emit } = setup();
        connect(emit, 's1', 'Alpha', 'allies');
        score(emit, 's1', 2, 1, { caps: 1 });

        // Prod boundary: ktp_match_start(half:2) THEN half_start(half:2). The
        // second must be a no-op (boundaryHandledForHalf) — no double-record.
        emit('ktp_match_start', { event: 'ktp_match_start', half: 2 });
        emit('half_start', { event: 'half_start', half: 2, timeleft: 1200 });

        // ktp_match_start wiped the arrays; rebuild the roster for half 2.
        connect(emit, 's1', 'Alpha', 'allies');
        score(emit, 's1', 1, 0, { caps: 0 });
        summary(emit, 'match_end', [row('s1', 'Alpha', 'allies', 1, 0)]);

        expect(boardPlayer(store, 's1').kills).toBe(3);   // 2 counted once + 1, not 2 + 2 + 1
        expect(boardPlayer(store, 's1').caps).toBe(1);
    });

    it('carries a player\'s totals across a reconnect + halftime team swap by user_id', () => {
        const { store, emit } = setup();
        // mogers-style: on axis in half 1, swaps to allies in half 2.
        connect(emit, 'mog', 'mogers', 'axis');
        score(emit, 'mog', 4, 2, { caps: 1, damage: 397 });
        summary(emit, 'half_end', [row('mog', 'mogers', 'axis', 4, 2, { caps: 1, damage: 397, best_streak: 4 })]);

        emit('half_start', { event: 'half_start', half: 2, timeleft: 1200 });
        connect(emit, 'mog', 'mogers', 'allies');   // reconnect on the other side
        emit('player_team_change', { event: 'player_team_change', user_id: 'mog', team: 'allies' });
        score(emit, 'mog', 1, 1, { caps: 2 });
        summary(emit, 'match_end', [row('mog', 'mogers', 'allies', 1, 1, { caps: 2, damage: 110, best_streak: 3 })]);

        const p = boardPlayer(store, 'mog');
        expect(p).toBeDefined();
        expect(p.kills).toBe(5);          // 4 (H1 axis) + 1 (H2 allies)
        expect(p.caps).toBe(3);           // 1 + 2
        expect(p.damage).toBe(507);       // 397 + 110
        expect(p.best_streak).toBe(4);    // max(4, 3)
        expect(p.team).toBe('allies');    // last-seen team
    });

    it('a brand-new match (half 1) drops any stale carry and lingering board', () => {
        const { store, emit } = setup();
        // Match A plays through both halves and ends with a match_end board still
        // on screen (boards persist by TTL until dismissed).
        connect(emit, 's1', 'Alpha', 'allies');
        score(emit, 's1', 9, 9);
        summary(emit, 'half_end', [row('s1', 'Alpha', 'allies', 9, 9)]);
        emit('half_start', { event: 'half_start', half: 2, timeleft: 1200 });
        connect(emit, 's1', 'Alpha', 'allies');
        score(emit, 's1', 1, 0);
        summary(emit, 'match_end', [row('s1', 'Alpha', 'allies', 1, 0)]);
        expect(store.getState().stats_board).not.toBeNull();              // match_end board showing
        expect(boardPlayer(store, 's1').kills).toBe(10);                  // 9 + 1 full-match total

        // Match B begins at half 1 — must clear the lingering board AND the carry.
        emit('ktp_match_start', { event: 'ktp_match_start', half: 1 });
        expect(store.getState().stats_board).toBeNull();

        connect(emit, 's2', 'Bravo', 'axis');
        score(emit, 's2', 2, 0);
        summary(emit, 'match_end', [row('s2', 'Bravo', 'axis', 2, 0)]);

        const board = store.getState().stats_board;
        expect(board.players.find(p => p.user_id === 's1')).toBeUndefined();   // no stale Alpha leak
        expect(board.players.find(p => p.user_id === 's2').kills).toBe(2);
    });

    it('match_end recovers players who left after the final capout (only in the last round_end)', () => {
        // ATL1 1782504158: the last capout summary had all 12 players; 6 quit in
        // the ~13s before match_end, which carries only still-connected players.
        // The departed must be recovered from the retained last round_end snapshot.
        const { store, emit } = setup();
        connect(emit, 'a', 'Ana', 'allies');
        connect(emit, 'b', 'Ben', 'axis');
        connect(emit, 'c', 'Cy', 'allies');   // top fragger — leaves before match_end

        summary(emit, 'round_end', [
            row('a', 'Ana', 'allies', 10, 5, { damage: 1000 }),
            row('b', 'Ben', 'axis', 8, 7, { damage: 800 }),
            row('c', 'Cy', 'allies', 20, 10, { damage: 5763 }),
        ], { capout_team: 'allies', capout_by: 'Ana' });

        emit('player_disconnect', { event: 'player_disconnect', user_id: 'c' });

        summary(emit, 'match_end', [
            row('a', 'Ana', 'allies', 10, 5, { damage: 1000 }),
            row('b', 'Ben', 'axis', 8, 7, { damage: 800 }),
        ]);

        const board = store.getState().stats_board;
        expect(board.reason).toBe('match_end');
        expect(board.players).toHaveLength(3);
        const cy = boardPlayer(store, 'c');
        expect(cy).toBeDefined();
        expect(cy.kills).toBe(20);
        expect(cy.damage).toBe(5763);
        // Still-connected rows take their authoritative match_end values.
        expect(boardPlayer(store, 'a').damage).toBe(1000);
    });

    it('recovers the half-1 carry from the last round_end when the changelevel empties the store and no half_end fires', () => {
        // ATL1: no half_end fired, and the H1→H2 changelevel disconnects everyone
        // (splicing the store) BEFORE the boundary — so the store snapshot is empty.
        // The last half-1 round_end snapshot must back the carry instead.
        const { store, emit } = setup();
        connect(emit, 'a', 'Ana', 'allies');
        connect(emit, 'b', 'Ben', 'axis');
        connect(emit, 'x', 'Xan', 'axis');   // plays half 1 only, leaves at halftime

        summary(emit, 'round_end', [
            row('a', 'Ana', 'allies', 5, 2, { damage: 400, caps: 1 }),
            row('b', 'Ben', 'axis', 3, 4, { damage: 250 }),
            row('x', 'Xan', 'axis', 6, 1, { damage: 600 }),
        ], { capout_team: 'allies', capout_by: 'Ana' });

        // Changelevel: every player disconnects, no half_end marker/summary survives.
        emit('player_disconnect', { event: 'player_disconnect', user_id: 'a' });
        emit('player_disconnect', { event: 'player_disconnect', user_id: 'b' });
        emit('player_disconnect', { event: 'player_disconnect', user_id: 'x' });
        emit('half_start', { event: 'half_start', half: 2, timeleft: 1200 });

        // Half 2: a and b return, x does not.
        connect(emit, 'a', 'Ana', 'allies');
        connect(emit, 'b', 'Ben', 'axis');
        summary(emit, 'round_end', [
            row('a', 'Ana', 'allies', 2, 1, { damage: 150, caps: 1 }),
            row('b', 'Ben', 'axis', 4, 2, { damage: 300 }),
        ], { capout_team: 'allies', capout_by: 'Ana' });
        summary(emit, 'match_end', [
            row('a', 'Ana', 'allies', 2, 1, { damage: 150, caps: 1 }),
            row('b', 'Ben', 'axis', 4, 2, { damage: 300 }),
        ]);

        // Both-halves player: full-match totals (H1 + H2).
        const a = boardPlayer(store, 'a');
        expect(a.kills).toBe(7);       // 5 + 2
        expect(a.damage).toBe(550);    // 400 + 150
        expect(a.caps).toBe(2);        // 1 + 1
        // Half-1-only player survives via the recovered carry, with half-1 stats.
        const x = boardPlayer(store, 'x');
        expect(x).toBeDefined();
        expect(x.kills).toBe(6);
        expect(x.damage).toBe(600);
    });

    it('clears the retained round_end snapshots on a fresh match (no cross-match leak)', () => {
        const { store, emit } = setup();
        // Match A plays both halves, each ending on a capout that retains s1.
        connect(emit, 's1', 'Alpha', 'allies');
        summary(emit, 'round_end', [row('s1', 'Alpha', 'allies', 9, 9, { damage: 999 })],
            { capout_team: 'allies', capout_by: 'Alpha' });
        emit('half_start', { event: 'half_start', half: 2, timeleft: 1200 });
        connect(emit, 's1', 'Alpha', 'allies');
        summary(emit, 'round_end', [row('s1', 'Alpha', 'allies', 4, 3, { damage: 444 })],
            { capout_team: 'allies', capout_by: 'Alpha' });
        summary(emit, 'match_end', [row('s1', 'Alpha', 'allies', 4, 3, { damage: 444 })]);

        // Match B begins at half 1 — must drop the retained snapshots for BOTH halves.
        emit('ktp_match_start', { event: 'ktp_match_start', half: 1 });
        connect(emit, 's2', 'Bravo', 'axis');
        summary(emit, 'match_end', [row('s2', 'Bravo', 'axis', 2, 0)]);

        const board = store.getState().stats_board;
        expect(board.players.find(p => p.user_id === 's1')).toBeUndefined();   // no stale Alpha leak
        expect(board.players).toHaveLength(1);
        expect(boardPlayer(store, 's2').kills).toBe(2);
    });

    it('titles the capout (round_end) board with capout_team / capout_by', () => {
        const { store, emit } = setup();
        connect(emit, 's1', 'omenator', 'allies');
        score(emit, 's1', 3, 1, { caps: 2 });
        summary(emit, 'round_end', [row('s1', 'omenator', 'allies', 3, 1, { caps: 2 })], {
            capout_team: 'allies', capout_by: 'omenator',
        });
        const board = store.getState().stats_board;
        expect(board.reason).toBe('round_end');
        expect(board.capout_team).toBe('allies');
        expect(board.capout_by).toBe('omenator');
    });
});
