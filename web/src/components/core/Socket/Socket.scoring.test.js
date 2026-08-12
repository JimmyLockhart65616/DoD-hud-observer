/**
 * Frontend territorial scoring-tick tests
 *
 * DoD awards periodic team points for holding control points, on the map's
 * control-point master's own clock. The game client shows this NOWHERE, so the
 * plugin reconstructs it and carries it as an optional `scoring` block on the
 * 4 Hz player_state snapshot.
 *
 * Unlike `waves` (two independent per-team clocks) this is ONE shared clock plus
 * a per-team projected award, and the two halves fail independently: the timing
 * is an observation, while the amount is a model the plugin corroborates online
 * and withholds when it can't. These tests pin that contract:
 *   - a full block anchors the clock, the period and both awards, receipt-stamped
 *   - a clock with NO award pair is valid and normal — the panel shows a
 *     countdown with no numbers (unvalidated map / stale dodx / rcon kill switch)
 *   - a half-populated award pair is treated as no awards at all
 *   - `+0` is a real projection and must survive, not be swallowed as falsy
 *   - a snapshot with no `scoring` key clears everything
 *   - the block is applied even when `players` is empty or malformed
 *   - `in` above one period is a broken emitter and is rejected wholesale
 *   - half and match boundaries clear it
 *
 * The failure mode worth guarding is a countdown that says the next award is
 * further away than it is: a caster reads that as time to contest a flag.
 *
 * Harness mirrors Socket.waves.test.js: socket.io-client mocked at load, fresh
 * component per test (RTL auto-unmount clears gameEvents handlers), opened with
 * a half-1 match start which resets the module-level carry/store state.
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

function setup() {
    render(React.createElement(SocketStoreComponent));
    const emit = (event, obj) => act(() => { gameEvents.emit(event, JSON.stringify(obj)); });
    emit('ktp_match_start', { event: 'ktp_match_start', half: 1 });
    return { store: useHudStore, emit };
}

function state(store) {
    const s = store.getState();
    return {
        in: s.scoring_in, at: s.scoring_at, every: s.scoring_every,
        allies: s.scoring_allies, axis: s.scoring_axis,
    };
}

function snapshot(emit, scoring, players = []) {
    emit('player_state', {
        event: 'player_state', players,
        ...(scoring === undefined ? {} : { scoring }),
    });
}

const FULL = { in: 12.75, every: 30.5, allies: 4, axis: 2 };

const CLEARED = { in: null, at: null, every: null, allies: null, axis: null };

describe('Socket store machine — territorial scoring tick', () => {

    it('anchors the clock, period and both awards from a full block', () => {
        const { store, emit } = setup();
        const before = Date.now();
        snapshot(emit, FULL);

        const s = state(store);
        expect(s.in).toBe(12.75);
        expect(s.every).toBe(30.5);
        expect(s.allies).toBe(4);
        expect(s.axis).toBe(2);
        // Receipt-stamped, not server-stamped: the HLTV delay buffer releases the
        // event, so "now" IS broadcast time and the clock needs no delay math.
        expect(s.at).toBeGreaterThanOrEqual(before);
    });

    it('keeps the clock when the award pair is absent', () => {
        // The single most important case: an unvalidated map, a dodx too old to
        // report control-point default owners, or `dod_hud_score_award 0` all
        // land here. The countdown must survive; only the numbers go dark.
        const { store, emit } = setup();
        snapshot(emit, { in: 8.5, every: 30.5 });

        const s = state(store);
        expect(s.in).toBe(8.5);
        expect(s.every).toBe(30.5);
        expect(s.allies).toBeNull();
        expect(s.axis).toBeNull();
    });

    it('treats a half-populated award pair as no awards', () => {
        // One number against a blank reads as "they get nothing", which is the
        // opposite of "we don't know".
        const { store, emit } = setup();
        snapshot(emit, { in: 8.5, every: 30.5, allies: 4 });

        const s = state(store);
        expect(s.in).toBe(8.5);
        expect(s.allies).toBeNull();
        expect(s.axis).toBeNull();
    });

    it('preserves a +0 award instead of swallowing it as falsy', () => {
        // A side holding only its own home flags banks nothing — that is real,
        // castable information, not an absence.
        const { store, emit } = setup();
        snapshot(emit, { in: 5, every: 30.5, allies: 0, axis: 4 });

        const s = state(store);
        expect(s.allies).toBe(0);
        expect(s.axis).toBe(4);
    });

    it('accepts a zero countdown (a tick landing right now)', () => {
        const { store, emit } = setup();
        snapshot(emit, { in: 0, every: 30.5, allies: 2, axis: 0 });

        expect(state(store).in).toBe(0);
    });

    it('clears everything when the snapshot carries no scoring key', () => {
        const { store, emit } = setup();
        snapshot(emit, FULL);
        snapshot(emit, undefined);

        expect(state(store)).toEqual(CLEARED);
    });

    it('clears when `in` is missing or not a number', () => {
        const { store, emit } = setup();

        snapshot(emit, FULL);
        snapshot(emit, { every: 30.5, allies: 4, axis: 2 });
        expect(state(store)).toEqual(CLEARED);

        snapshot(emit, FULL);
        snapshot(emit, { in: 'soon', every: 30.5 });
        expect(state(store)).toEqual(CLEARED);

        snapshot(emit, FULL);
        snapshot(emit, { in: -3, every: 30.5 });
        expect(state(store)).toEqual(CLEARED);
    });

    it('rejects a countdown longer than one period', () => {
        // The plugin's estimator re-anchors on every observed tick and refuses to
        // extrapolate past one cycle, so it can never honestly report more than
        // `every`. Anything above it is a broken or older emitter.
        const { store, emit } = setup();
        snapshot(emit, { in: 45, every: 30.5, allies: 4, axis: 2 });

        expect(state(store)).toEqual(CLEARED);
    });

    it('allows a countdown fractionally over the period', () => {
        // Float noise around the anchor instant must not blank the panel.
        const { store, emit } = setup();
        snapshot(emit, { in: 30.9, every: 30.5, allies: 4, axis: 2 });

        expect(state(store).in).toBe(30.9);
    });

    it('falls back to a 60s ceiling when the plugin omits `every`', () => {
        // The closed-loop native answers directly, so the estimator never locks a
        // measured period and `every` is omitted. The clock must still apply.
        const { store, emit } = setup();

        snapshot(emit, { in: 27.5 });
        let s = state(store);
        expect(s.in).toBe(27.5);
        expect(s.every).toBeNull();

        snapshot(emit, { in: 120 });
        expect(state(store)).toEqual(CLEARED);
    });

    it('ignores a non-positive `every` rather than trusting it as a ceiling', () => {
        const { store, emit } = setup();
        snapshot(emit, { in: 27.5, every: 0 });

        const s = state(store);
        expect(s.in).toBe(27.5);
        expect(s.every).toBeNull();
    });

    it('applies on an empty players array', () => {
        // A full team wipe ships an empty array with the team-level blocks still
        // populated — the tick keeps counting whether anyone is alive or not.
        const { store, emit } = setup();
        snapshot(emit, FULL, []);

        expect(state(store).in).toBe(12.75);
    });

    it('applies before the players guard on a malformed players field', () => {
        const { store, emit } = setup();
        emit('player_state', { event: 'player_state', scoring: FULL, players: null });

        expect(state(store).in).toBe(12.75);
    });

    it('clears at a half boundary', () => {
        const { store, emit } = setup();
        snapshot(emit, FULL);
        emit('half_start', { event: 'half_start', half: 2 });

        expect(state(store)).toEqual(CLEARED);
    });

    it('clears at a fresh match', () => {
        const { store, emit } = setup();
        snapshot(emit, FULL);
        emit('ktp_match_start', { event: 'ktp_match_start', half: 1 });

        expect(state(store)).toEqual(CLEARED);
    });
});
