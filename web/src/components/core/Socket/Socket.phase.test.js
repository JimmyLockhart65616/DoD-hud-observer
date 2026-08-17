/**
 * Frontend match-phase store tests
 *
 * The broadcast phase (warm-up / going live / which half / halftime / OT break /
 * final) is computed entirely plugin-side and arrives as its own `match_phase`
 * event. The frontend must never infer it, and — the point of most of these
 * cases — must not DROP it at the moments the rest of the store resets.
 *
 * Same state-isolation approach as the other Socket suites: socket.io-client is
 * mocked, each test mounts a fresh component and opens with a half-1 boundary
 * (which is also what clears the phase slice between tests).
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

const phase = (p, mode = '') => ({ event: 'match_phase', phase: p, mode });

describe('match_phase — store contract', () => {
    it('records the phase and its mode', () => {
        const { store, emit } = setup();
        emit('match_phase', phase('halftime', 'h2'));
        expect(store.getState().match_phase).toBe('halftime');
        expect(store.getState().match_mode).toBe('h2');
    });

    it('defaults a missing mode to the empty string rather than undefined', () => {
        const { store, emit } = setup();
        act(() => { gameEvents.emit('match_phase', JSON.stringify({ event: 'match_phase', phase: 'live' })); });
        expect(store.getState().match_phase).toBe('live');
        expect(store.getState().match_mode).toBe('');
    });

    it('ignores a malformed event, leaving the previous phase standing', () => {
        // Blanking the badge on air is worse than briefly holding the last good
        // value — the next poll is 2s away.
        const { store, emit } = setup();
        emit('match_phase', phase('live'));
        emit('match_phase', { event: 'match_phase' });
        emit('match_phase', { event: 'match_phase', phase: 42 });
        expect(store.getState().match_phase).toBe('live');
    });

    it('clears the phase at a FRESH-MATCH boundary', () => {
        // Half 1 means a new match: the previous match's FINAL must not linger.
        // Played out as a full match cycle (h1 → h2 → next match's h1), because
        // handleHalfBoundary de-dupes on the last half it handled — a bare repeat
        // of half 1 is the prod double-boundary and is deliberately a no-op.
        const { store, emit } = setup();
        emit('ktp_match_start', { event: 'ktp_match_start', half: 2 });
        emit('match_phase', phase('postmatch'));
        emit('ktp_match_start', { event: 'ktp_match_start', half: 1 });
        expect(store.getState().match_phase).toBeNull();
        expect(store.getState().match_mode).toBe('');
    });

    it('does NOT clear the phase at a half-2 boundary', () => {
        // The regression this guards: clearing on every ktp_match_start blanks
        // the badge at halftime, which is exactly when it matters most.
        const { store, emit } = setup();
        emit('match_phase', phase('halftime', 'h2'));
        emit('ktp_match_start', { event: 'ktp_match_start', half: 2 });
        expect(store.getState().match_phase).toBe('halftime');
        expect(store.getState().match_mode).toBe('h2');
    });

    it('does not clear the phase at an OT boundary either', () => {
        const { store, emit } = setup();
        emit('match_phase', phase('ot_break', 'ot1'));
        emit('ktp_match_start', { event: 'ktp_match_start', half: 101 });
        expect(store.getState().match_phase).toBe('ot_break');
    });

    it('survives half_start and resetHalf', () => {
        // resetHalf wipes per-player state and the clock; the phase is match-level
        // and must not be collateral.
        const { store, emit } = setup();
        emit('match_phase', phase('golive'));
        emit('half_start', { event: 'half_start', half: 2, timeleft: 1200 });
        expect(store.getState().match_phase).toBe('golive');
    });

    it('keeps a golive that arrives BEFORE its ktp_match_start', () => {
        // The phase rides its own POST and can overtake the lifecycle event.
        const { store, emit } = setup();
        emit('match_phase', phase('golive'));
        emit('ktp_match_start', { event: 'ktp_match_start', half: 2 });
        emit('half_start', { event: 'half_start', half: 2, timeleft: 1200 });
        expect(store.getState().match_phase).toBe('golive');
    });

    it('starts null so the badge renders nothing on a pre-2.3.0 stream', () => {
        const { store } = setup();
        expect(store.getState().match_phase).toBeNull();
    });
});
