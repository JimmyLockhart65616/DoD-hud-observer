/**
 * Frontend time-sync tests
 *
 * Covers the steady-state HLTV↔overlay sync fixes that live in the frontend
 * event handlers (driven through the real gameEvents bus, same as the chaos
 * suite):
 *   - prone shame timer anchors on the client RECEIPT instant, not the plugin's
 *     server timestamp (which is ~delay+skew stale because the event is
 *     delay-buffered before the frontend ever sees it)
 *   - the snapshot roster_player replay re-anchors prone_since on receipt
 *   - a time_sync anchors timeleft at Date.now() (it pairs with the backend's
 *     age-adjusted snapshot value to keep a fresh tab's countdown correct)
 *
 * Same state-isolation approach as Socket.chaos.test.js: socket.io-client is
 * mocked, each test mounts a fresh component and opens with a half-1 boundary.
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

function connect(emit, id, name, team) {
    emit('player_connect', { event: 'player_connect', user_id: id, name, team });
}
function findAllied(store, id) {
    return store.getState().allies_players.find(p => p.user_id === id);
}

// A timestamp far in the past — if prone_since ever equals this, the code wrongly
// used the plugin's server stamp instead of the receipt instant.
const STALE_TS = 1_000_000; // ~1970

describe('Socket store machine — prone shame timer anchoring', () => {
    it('anchors prone_since on receipt, not the stale server timestamp', () => {
        const { store, emit } = setup();
        connect(emit, 's1', 'Alpha', 'allies');

        const before = Date.now();
        emit('prone_change', { event: 'prone_change', user_id: 's1', state: 'prone', timestamp: STALE_TS });
        const after = Date.now();

        const p = findAllied(store, 's1');
        expect(p.prone_state).toBe('prone');
        expect(p.prone_since).not.toBe(STALE_TS);
        expect(p.prone_since).toBeGreaterThanOrEqual(before);
        expect(p.prone_since).toBeLessThanOrEqual(after);
    });

    it('also anchors deployed (MG/sniper) on receipt', () => {
        const { store, emit } = setup();
        connect(emit, 's1', 'Alpha', 'allies');
        const before = Date.now();
        emit('prone_change', { event: 'prone_change', user_id: 's1', state: 'deployed', timestamp: STALE_TS });
        const p = findAllied(store, 's1');
        expect(p.prone_state).toBe('deployed');
        expect(p.prone_since).toBeGreaterThanOrEqual(before);
    });

    it('clears prone_since when the player stands up', () => {
        const { store, emit } = setup();
        connect(emit, 's1', 'Alpha', 'allies');
        emit('prone_change', { event: 'prone_change', user_id: 's1', state: 'prone', timestamp: STALE_TS });
        emit('prone_change', { event: 'prone_change', user_id: 's1', state: 'standing', timestamp: STALE_TS });
        const p = findAllied(store, 's1');
        expect(p.prone_state).toBe('standing');
        expect(p.prone_since).toBeNull();
    });

    it('re-anchors prone_since on a snapshot roster_player replay (reload case)', () => {
        const { store, emit } = setup();
        const before = Date.now();
        // Snapshot replay carries the OLD server prone_since; the handler must ignore
        // it and re-anchor so a reloaded tab restarts the timer from ~0.
        emit('roster_player', {
            event: 'roster_player', user_id: 's2', name: 'Bravo', team: 'allies',
            alive: true, class_id: 3, weapon_primary: 'bar', weapon_secondary: 'colt',
            health: 100, prone_state: 'prone', prone_since: STALE_TS,
        });
        const p = findAllied(store, 's2');
        expect(p.prone_since).not.toBe(STALE_TS);
        expect(p.prone_since).toBeGreaterThanOrEqual(before);
    });

    it('roster_player standing has null prone_since', () => {
        const { store, emit } = setup();
        emit('roster_player', {
            event: 'roster_player', user_id: 's3', name: 'Charlie', team: 'axis',
            alive: true, class_id: 0, weapon_primary: 'kar', weapon_secondary: 'luger',
            health: 100, prone_state: 'standing', prone_since: null,
        });
        const p = store.getState().axis_players.find(x => x.user_id === 's3');
        expect(p.prone_since).toBeNull();
    });
});

describe('Socket store machine — timeleft anchoring', () => {
    it('a time_sync anchors timeleft at the receipt instant', () => {
        const { store, emit } = setup();
        const before = Date.now();
        // The backend already age-adjusted this value; the frontend anchors it at
        // receipt, so a fresh tab's countdown is correct rather than minutes stale.
        emit('time_sync', { event: 'time_sync', timeleft: 510 });
        const after = Date.now();
        expect(store.getState().timeleft).toBe(510);
        expect(store.getState().timeleft_at).toBeGreaterThanOrEqual(before);
        expect(store.getState().timeleft_at).toBeLessThanOrEqual(after);
    });
});
