/**
 * Frontend reinforcement-wave clock tests
 *
 * DoD respawn is a per-TEAM wave that arms on that side's first death and is
 * idle while nobody is waiting, so each side's clock is independently present
 * or absent. The plugin carries it as an optional `waves` block on the 4 Hz
 * player_state snapshot, omitting any side whose clock is idle or unreadable.
 *
 * These tests pin the store contract the WavePill renders from:
 *   - a full block anchors both sides with a receipt timestamp
 *   - a one-sided block nulls the other side rather than leaving it stale
 *   - a snapshot with no `waves` key at all clears both
 *   - the block is applied even when `players` is empty (a full team wipe is
 *     exactly when the pill matters) or malformed
 *   - a countdown that jumps back UP is a wrapped open-loop estimate, not a new
 *     wave: the side is dropped and LATCHED off until the clock goes idle
 *   - half and match boundaries clear both clocks
 *
 * A stale countdown is the failure mode worth guarding: a pill still ticking
 * after everyone respawned is worse on air than no pill at all.
 *
 * Harness mirrors Socket.chaos.test.js: socket.io-client mocked at load, fresh
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
        allies: s.wave_allies, alliesAt: s.wave_allies_at, alliesPending: s.wave_allies_pending,
        axis: s.wave_axis, axisAt: s.wave_axis_at, axisPending: s.wave_axis_pending,
    };
}

function snapshot(emit, waves, players = []) {
    emit('player_state', { event: 'player_state', players, ...(waves === undefined ? {} : { waves }) });
}

const BOTH = {
    allies: { in: 3.25, pending: 2 },
    axis:   { in: 7.75, pending: 4 },
};

describe('Socket store machine — reinforcement wave clocks', () => {

    it('anchors both sides from a full waves block', () => {
        const { store, emit } = setup();
        const before = Date.now();
        snapshot(emit, BOTH);

        const s = state(store);
        expect(s.allies).toBe(3.25);
        expect(s.alliesPending).toBe(2);
        expect(s.axis).toBe(7.75);
        expect(s.axisPending).toBe(4);
        // Receipt-stamped, not server-stamped: the HLTV delay buffer releases the
        // event, so "now" IS broadcast time and the pill needs no delay math.
        expect(s.alliesAt).toBeGreaterThanOrEqual(before);
        expect(s.axisAt).toBeGreaterThanOrEqual(before);
    });

    it('nulls the omitted side rather than leaving it stale', () => {
        const { store, emit } = setup();
        snapshot(emit, BOTH);

        // Axis wave lands, everyone is back up — the plugin stops sending that side.
        snapshot(emit, { allies: { in: 1.5, pending: 1 } });

        const s = state(store);
        expect(s.allies).toBe(1.5);
        expect(s.alliesPending).toBe(1);
        expect(s.axis).toBeNull();
        expect(s.axisAt).toBeNull();
        expect(s.axisPending).toBe(0);
    });

    it('clears both clocks when a snapshot carries no waves block', () => {
        const { store, emit } = setup();
        snapshot(emit, BOTH);
        snapshot(emit, undefined);

        const s = state(store);
        expect(s.allies).toBeNull();
        expect(s.axis).toBeNull();
        expect(s.alliesPending).toBe(0);
        expect(s.axisPending).toBe(0);
    });

    it('applies the block on a full team wipe (empty players array)', () => {
        const { store, emit } = setup();
        snapshot(emit, { axis: { in: 4.0, pending: 6 } }, []);

        const s = state(store);
        expect(s.axis).toBe(4.0);
        expect(s.axisPending).toBe(6);
    });

    it('applies the block even when players is malformed', () => {
        const { store, emit } = setup();
        // The players guard early-returns; the wave block must already be applied.
        act(() => {
            gameEvents.emit('player_state', JSON.stringify({
                event: 'player_state', players: null, waves: { allies: { in: 2.0, pending: 3 } },
            }));
        });

        const s = state(store);
        expect(s.allies).toBe(2.0);
        expect(s.alliesPending).toBe(3);
    });

    it('defaults pending to 0 when the side carries only a time', () => {
        const { store, emit } = setup();
        snapshot(emit, { allies: { in: 5.0 } });

        const s = state(store);
        expect(s.allies).toBe(5.0);
        expect(s.alliesPending).toBe(0);
    });

    it('ignores a side whose time is not a number', () => {
        const { store, emit } = setup();
        snapshot(emit, BOTH);
        snapshot(emit, { allies: { in: null, pending: 2 }, axis: { in: 6.0, pending: 1 } });

        const s = state(store);
        expect(s.allies).toBeNull();
        expect(s.alliesPending).toBe(0);
        expect(s.axis).toBe(6.0);
    });

    // ── Wrap guard ───────────────────────────────────────────────────────────
    //
    // Pre-2.3.1 plugins ran the open-loop estimate modulo the respawn period, so
    // a wave that outlived its predicted deadline restarted the countdown from
    // the top — 00:00 followed a second later by a confident 00:10. Within one
    // arming the remaining time only ever falls, and a real re-arm can only come
    // after an idle poll (which nulls the side first), so an increase is always
    // that wrap.

    it('drops a side whose countdown jumps back up', () => {
        const { store, emit } = setup();
        snapshot(emit, { allies: { in: 0.25, pending: 2 }, axis: { in: 7.75, pending: 1 } });

        // Deadline passed with the side still waiting: the old estimate wraps.
        snapshot(emit, { allies: { in: 10.0, pending: 2 }, axis: { in: 7.0, pending: 1 } });

        const s = state(store);
        expect(s.allies).toBeNull();
        expect(s.alliesAt).toBeNull();
        // The other side is untouched — the phases are unrelated.
        expect(s.axis).toBe(7.0);
    });

    it('stays dropped for the rest of the wrapped cycle', () => {
        const { store, emit } = setup();
        snapshot(emit, { allies: { in: 0.25, pending: 2 } });
        snapshot(emit, { allies: { in: 10.0, pending: 2 } });

        // 250ms later the same bogus cycle would otherwise re-enter at 00:09.
        snapshot(emit, { allies: { in: 9.75, pending: 2 } });
        expect(state(store).allies).toBeNull();
    });

    it('re-admits the side once the clock goes idle', () => {
        const { store, emit } = setup();
        snapshot(emit, { allies: { in: 0.25, pending: 2 } });
        snapshot(emit, { allies: { in: 10.0, pending: 2 } });

        // Wave lands, nobody waiting — the plugin omits the side, releasing the latch.
        snapshot(emit, {});
        expect(state(store).allies).toBeNull();

        snapshot(emit, { allies: { in: 10.0, pending: 1 } });
        expect(state(store).allies).toBe(10.0);
    });

    it('tolerates sub-second jitter without dropping the side', () => {
        const { store, emit } = setup();
        snapshot(emit, { allies: { in: 5.0, pending: 2 } });
        snapshot(emit, { allies: { in: 5.4, pending: 2 } });

        expect(state(store).allies).toBe(5.4);
    });

    it('releases the wrap latch at a half boundary', () => {
        const { store, emit } = setup();
        snapshot(emit, { allies: { in: 0.25, pending: 2 } });
        snapshot(emit, { allies: { in: 10.0, pending: 2 } });

        emit('half_start', { event: 'half_start', half: 2, timeleft: 1200 });
        snapshot(emit, { allies: { in: 8.0, pending: 3 } });

        expect(state(store).allies).toBe(8.0);
    });

    it('clears both clocks at the half boundary', () => {
        const { store, emit } = setup();
        snapshot(emit, BOTH);

        emit('half_start', { event: 'half_start', half: 2, timeleft: 1200 });

        const s = state(store);
        expect(s.allies).toBeNull();
        expect(s.axis).toBeNull();
        expect(s.alliesPending).toBe(0);
        expect(s.axisPending).toBe(0);
    });

    it('clears both clocks on a fresh match', () => {
        const { store, emit } = setup();
        snapshot(emit, BOTH);

        emit('ktp_match_start', { event: 'ktp_match_start', half: 1 });

        const s = state(store);
        expect(s.allies).toBeNull();
        expect(s.axis).toBeNull();
    });
});
