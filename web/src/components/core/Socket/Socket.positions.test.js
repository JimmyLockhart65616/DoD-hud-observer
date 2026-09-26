/**
 * Frontend store-machine tests — live position (`pos`), post-2026-09-25
 * access-control change.
 *
 * BOTH shapes are live, depending on the backend's
 * `caster_auth.gate_positions`. OFF (the default, and the behaviour that
 * predates any of this) x/y ride the public `player_state` snapshot. ON they
 * arrive only on `player_positions`, which reaches nobody but an
 * authenticated caster socket, and `player_state` carries none.
 *
 * The frontend has to be correct under both, which is why an ABSENT x/y
 * leaves `.pos` untouched rather than nulling it — nulling would fight
 * `player_positions` for the field, 4x/sec, on independent timers.
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

describe('pos with the backend gate OFF (the default): x/y ride player_state', () => {
    test('a fresh spawn has no position', () => {
        const { store, emit } = setup();
        spawn(emit);
        expect(find(store, RIFLE).pos).toBeNull();
    });

    test('a snapshot carrying x/y sets the position', () => {
        const { store, emit } = setup();
        spawn(emit);
        playerState(emit, [{ user_id: RIFLE, weapon: 'garand', nades: 2, x: 500, y: -300 }]);

        expect(find(store, RIFLE).pos).toEqual({ x: 500, y: -300 });
    });

    test('an exact (0,0) is the plugin saying it could not read the origin, so the marker hides', () => {
        const { store, emit } = setup();
        spawn(emit);
        playerState(emit, [{ user_id: RIFLE, weapon: 'garand', nades: 2, x: 5, y: 5 }]);
        playerState(emit, [{ user_id: RIFLE, weapon: 'garand', nades: 2, x: 0, y: 0 }]);

        expect(find(store, RIFLE).pos).toBeNull();
    });
});

describe('pos with the backend gate ON: player_state carries no x/y at all', () => {
    // The load-bearing case. With the gate on, every player_state arrives
    // stripped, 4x/sec, while player_positions maintains `.pos` on its own
    // timer. If the stripped snapshot nulled `.pos` the two would fight and
    // an authenticated caster's markers would flicker — invisible in any
    // test that only drives one of the two events.
    test('a snapshot with no x/y leaves an existing position alone', () => {
        const { store, emit } = setup();
        spawn(emit);
        playerPositions(emit, [{ user_id: RIFLE, x: 120, y: -45 }]);
        expect(find(store, RIFLE).pos).toEqual({ x: 120, y: -45 });

        playerState(emit, [{ user_id: RIFLE, weapon: 'garand', nades: 2 }]); // stripped
        expect(find(store, RIFLE).pos).toEqual({ x: 120, y: -45 });
    });

    test('interleaving the two events at speed never drops the position', () => {
        const { store, emit } = setup();
        spawn(emit);
        for (let i = 0; i < 5; i++) {
            playerPositions(emit, [{ user_id: RIFLE, x: i, y: i }]);
            playerState(emit, [{ user_id: RIFLE, weapon: 'garand', nades: 2 }]);
        }
        expect(find(store, RIFLE).pos).toEqual({ x: 4, y: 4 });
    });

    test('the rest of a stripped snapshot still applies normally', () => {
        const { store, emit } = setup();
        spawn(emit);
        playerState(emit, [{ user_id: RIFLE, weapon: 'garand', nades: 2 }]);
        expect(find(store, RIFLE).nades).toBe(2);
        expect(find(store, RIFLE).weapon_active).toBe('garand');
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
