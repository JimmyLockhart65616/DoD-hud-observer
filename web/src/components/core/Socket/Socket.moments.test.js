/**
 * Frontend derived caster-stat tests ("Moments" panel)
 *
 * Three facts accumulated as events arrive, none of which the scoreboard can
 * show: who ended a streak, the fastest multi-kill, and who cleared the way
 * before a capture.
 *
 * These are ACCUMULATED in the store rather than derived at render from
 * `kill_log`, because that slice is capped at 150 entries — a long half can
 * exceed it and a render-time derivation would silently become a moving window.
 * That makes the store the contract, and these the tests for it:
 *
 *   - a shutdown needs the victim's streak read BEFORE it is reset; the reset
 *     is the whole hazard, since nothing else carries the pre-death value
 *   - teamkills and suicides credit nothing, matching the plugin's rule that
 *     they never score
 *   - a burst continues only while the killer stays alive AND the kills are
 *     close together; dying always starts a fresh chain regardless of the clock
 *   - cap setups count kills BY the capturing side inside the window only
 *   - everything clears at a half boundary, like kill_streaks
 *
 * Harness mirrors Socket.waves.test.js: socket.io-client mocked at load, fresh
 * component per test, opened with a half-1 match start.
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

const ALLY = 'STEAM_0:0:1001';
const ALLY2 = 'STEAM_0:0:1002';
const AXIS = 'STEAM_0:0:2001';

function setup() {
    render(React.createElement(SocketStoreComponent));
    const emit = (event, obj) => act(() => { gameEvents.emit(event, JSON.stringify(obj)); });
    emit('ktp_match_start', { event: 'ktp_match_start', half: 1 });

    // A roster, so kill entries resolve killer/victim objects with a team --
    // cap setups filter on killer.team and would count nothing without it.
    emit('player_connect', { event: 'player_connect', user_id: ALLY,  name: 'Raphinha', team: 'allies' });
    emit('player_connect', { event: 'player_connect', user_id: ALLY2, name: 'bud',      team: 'allies' });
    emit('player_connect', { event: 'player_connect', user_id: AXIS,  name: 'mogers',   team: 'axis' });

    const kill = (killer_id, victim_id, extra = {}) => emit('kill', {
        event: 'kill', killer_id, victim_id, weapon: 'garand',
        kill_type: 'normal', kill_class: 'gun', headshot: false,
        victim_prone: false, killer_prone: false, assist_ids: [], ...extra,
    });

    return { store: useHudStore, emit, kill };
}

const derived = (store) => store.getState().derived;

describe('shutdowns', () => {
    it('credits ending a streak, using the victim streak from BEFORE the reset', () => {
        const { store, kill } = setup();

        // Axis builds a 3-streak on two allies.
        kill(AXIS, ALLY);
        kill(AXIS, ALLY2);
        kill(AXIS, ALLY);
        expect(store.getState().kill_streaks[AXIS]).toBe(3);

        kill(ALLY2, AXIS);

        expect(derived(store).shutdowns[ALLY2]).toEqual({ count: 1, best: 3 });
        // And the victim's streak is still reset as before.
        expect(store.getState().kill_streaks[AXIS]).toBe(0);
    });

    it('records the LONGEST streak ended, not the latest', () => {
        const { store, kill } = setup();

        for (let i = 0; i < 5; i++) kill(AXIS, ALLY);
        kill(ALLY2, AXIS);                       // ends a 5

        for (let i = 0; i < 3; i++) kill(AXIS, ALLY);
        kill(ALLY2, AXIS);                       // ends a 3

        expect(derived(store).shutdowns[ALLY2]).toEqual({ count: 2, best: 5 });
    });

    it('ignores a streak below the threshold', () => {
        const { store, kill } = setup();

        kill(AXIS, ALLY);
        kill(AXIS, ALLY);                        // streak 2, under the minimum
        kill(ALLY2, AXIS);

        expect(derived(store).shutdowns[ALLY2]).toBeUndefined();
    });

    // The plugin applies no frag penalty for a TK or a suicide and neither does
    // the HUD; crediting one here would be the same class of error.
    it('credits nothing for a teamkill', () => {
        const { store, kill } = setup();

        for (let i = 0; i < 4; i++) kill(AXIS, ALLY);
        kill(ALLY, ALLY2, { kill_type: 'teamkill' });

        expect(derived(store).shutdowns[ALLY]).toBeUndefined();
    });
});

describe('bursts', () => {
    it('counts consecutive kills inside the gap as one burst', () => {
        const { store, kill } = setup();

        kill(ALLY, AXIS);
        kill(ALLY, AXIS);
        kill(ALLY, AXIS);

        expect(derived(store).chains[ALLY].n).toBe(3);
    });

    it('does not record a single kill as a burst', () => {
        const { store, kill } = setup();
        kill(ALLY, AXIS);
        expect(derived(store).chains[ALLY]).toBeUndefined();
    });

    // Dying resets the streak to 0, so the next kill lands on streak 1. That is
    // what ends a burst -- not the clock, which in a test runs in ~0ms.
    it('starts a fresh burst after the killer dies', () => {
        const { store, kill } = setup();

        kill(ALLY, AXIS);
        kill(ALLY, AXIS);
        kill(ALLY, AXIS);
        expect(derived(store).chains[ALLY].n).toBe(3);

        kill(AXIS, ALLY);                        // ALLY dies -> streak resets
        kill(ALLY, AXIS);
        kill(ALLY, AXIS);

        // Best of the half is still the 3, not the new 2.
        expect(derived(store).chains[ALLY].n).toBe(3);
    });

    it('keeps the longer burst when a later one is shorter', () => {
        const { store, kill } = setup();

        for (let i = 0; i < 4; i++) kill(ALLY, AXIS);
        expect(derived(store).chains[ALLY].n).toBe(4);

        kill(AXIS, ALLY);
        kill(ALLY, AXIS);
        kill(ALLY, AXIS);

        expect(derived(store).chains[ALLY].n).toBe(4);
    });
});

describe('cap setups', () => {
    const capture = (emit, owner) => emit('flag_captured', {
        event: 'flag_captured', flag_id: 0, flag_name: 'Anzio Hill',
        new_owner: owner, captor_ids: [ALLY],
    });

    it('credits kills by the capturing side in the window', () => {
        const { store, emit, kill } = setup();

        kill(ALLY, AXIS);
        kill(ALLY2, AXIS);
        capture(emit, 'allies');

        expect(derived(store).cap_setups[ALLY]).toBe(1);
        expect(derived(store).cap_setups[ALLY2]).toBe(1);
    });

    // A third party thinning the defence is not that team setting up its own cap.
    it('ignores kills by the side that did NOT capture', () => {
        const { store, emit, kill } = setup();

        kill(AXIS, ALLY);
        capture(emit, 'allies');

        expect(derived(store).cap_setups[AXIS]).toBeUndefined();
    });

    it('ignores a neutral reset', () => {
        const { store, emit, kill } = setup();

        kill(ALLY, AXIS);
        capture(emit, 'neutral');

        expect(derived(store).cap_setups).toEqual({});
    });

    it('ignores kills older than the window', () => {
        const { store, emit, kill } = setup();

        kill(ALLY, AXIS);
        // Age the entry past the 30s lookback without touching the clock.
        act(() => {
            const log = store.getState().kill_log.map(k => ({ ...k, addedAt: k.addedAt - 60_000 }));
            store.setState({ kill_log: log });
        });
        capture(emit, 'allies');

        expect(derived(store).cap_setups).toEqual({});
    });
});

describe('boundaries', () => {
    it('clears every derived stat at a half boundary', () => {
        const { store, emit, kill } = setup();

        for (let i = 0; i < 4; i++) kill(AXIS, ALLY);
        kill(ALLY2, AXIS);
        emit('flag_captured', {
            event: 'flag_captured', flag_id: 0, flag_name: 'Anzio Hill',
            new_owner: 'allies', captor_ids: [ALLY2],
        });

        expect(derived(store).shutdowns[ALLY2]).toBeDefined();
        expect(derived(store).chains[AXIS]).toBeDefined();

        emit('half_start', { event: 'half_start', half: 2 });

        expect(derived(store)).toEqual({ shutdowns: {}, chains: {}, cap_setups: {} });
        expect(store.getState().chain_run).toEqual({});
    });
});
