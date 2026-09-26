/**
 * Frontend store-machine tests — live position (`pos`), post-2026-09-25
 * access-control change.
 *
 * Positions used to arrive as `x`/`y` fields on the public `player_state`
 * snapshot; they now arrive ONLY on a separate `player_positions` event,
 * which the backend sends to nobody but an authenticated caster session
 * (backend/src/handler/ingest.ts's makeFireToSockets). This file pins the
 * frontend half of that: `player_state` must NOT touch `.pos` any more (it
 * would otherwise fight `player_positions` for the field, since the two
 * arrive on independent timers — see the comment in Socket.jsx), and
 * `player_positions` must behave like every other per-tick snapshot here
 * (Socket.nades.test.js's contract: omitted stays, unknown user is dropped,
 * malformed input does not throw).
 *
 * Mechanics mirror Socket.nades.test.js.
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

const RIFLE = 'STEAM_0:0:1001';

function setup() {
    render(React.createElement(SocketStoreComponent));
    const emit = (event, obj) => act(() => { gameEvents.emit(event, JSON.stringify(obj)); });
    emit('ktp_match_start', { event: 'ktp_match_start', half: 1 });
    return { store: useHudStore, emit };
}

function spawn(emit, user_id = RIFLE, team = 'allies') {
    emit('player_connect', { event: 'player_connect', user_id, name: 'Rifleman', team });
    emit('player_spawn', {
        event: 'player_spawn', user_id, team, class_id: 0,
        weapon_primary: 'garand', weapon_secondary: 'colt', health: 100,
    });
}

function playerState(emit, players) {
    emit('player_state', { event: 'player_state', players });
}

function playerPositions(emit, players) {
    emit('player_positions', { event: 'player_positions', players });
}

const find = (store, user_id) => {
    const { allies_players, axis_players } = store.getState();
    return [...allies_players, ...axis_players].find((p) => p.user_id === user_id);
};

describe('pos defaults to null and stays there with no player_positions event', () => {
    test('a fresh spawn has no position', () => {
        const { store, emit } = setup();
        spawn(emit);
        expect(find(store, RIFLE).pos).toBeNull();
    });

    // The load-bearing regression this file exists for: before the split,
    // player_state carried x/y and set `.pos` itself. If that code path were
    // ever restored (or partially reverted), a public player_state payload
    // that happens to include x/y (e.g. an old cached build, a proxy that
    // didn't strip it) would silently repopulate `.pos` outside the
    // authenticated channel, and this is the only place that would catch it.
    test('player_state carrying x/y (as it never should again) is ignored, not applied', () => {
        const { store, emit } = setup();
        spawn(emit);
        playerState(emit, [{ user_id: RIFLE, weapon: 'garand', nades: 2, health: 100, prone_state: 'standing', x: 500, y: -300 }]);

        expect(find(store, RIFLE).pos).toBeNull();
        expect(find(store, RIFLE).nades).toBe(2); // the rest of the snapshot still applies normally
    });
});

describe('player_positions → pos', () => {
    test('populates the position', () => {
        const { store, emit } = setup();
        spawn(emit);
        playerPositions(emit, [{ user_id: RIFLE, x: 120, y: -45 }]);

        expect(find(store, RIFLE).pos).toEqual({ x: 120, y: -45 });
    });

    test('a player omitted from a positions tick keeps their last known position', () => {
        const { store, emit } = setup();
        const other = 'STEAM_0:0:3003';
        spawn(emit, RIFLE, 'allies');
        spawn(emit, other, 'allies');
        playerPositions(emit, [{ user_id: RIFLE, x: 1, y: 1 }, { user_id: other, x: 2, y: 2 }]);

        playerPositions(emit, [{ user_id: RIFLE, x: 9, y: 9 }]); // other omitted this tick

        expect(find(store, RIFLE).pos).toEqual({ x: 9, y: 9 });
        expect(find(store, other).pos).toEqual({ x: 2, y: 2 });
    });

    test('an unknown user_id does not create a phantom player', () => {
        const { store, emit } = setup();
        spawn(emit);
        playerPositions(emit, [{ user_id: 'STEAM_0:0:9999', x: 1, y: 1 }]);

        const { allies_players, axis_players } = store.getState();
        expect([...allies_players, ...axis_players].map((p) => p.user_id)).toEqual([RIFLE]);
    });

    test('a malformed payload is ignored rather than throwing', () => {
        const { store, emit } = setup();
        spawn(emit);
        playerPositions(emit, [{ user_id: RIFLE, x: 5, y: 5 }]);

        emit('player_positions', { event: 'player_positions' });                 // no players array
        emit('player_positions', { event: 'player_positions', players: 'nope' }); // wrong type

        expect(find(store, RIFLE).pos).toEqual({ x: 5, y: 5 });
    });
});
