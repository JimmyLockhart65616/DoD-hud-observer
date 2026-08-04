/**
 * Frontend store-machine tests — live grenade count (`nades`)
 *
 * `nades` has exactly ONE producer (the 4 Hz `player_state` snapshot) and four
 * things that null it (`player_spawn`, `kill`, `resetHalf`, `resetMatch`).
 * Nothing else can restore it: the backend treats `player_state` as socket-only
 * with no reducer arm and no cache, so a join snapshot carries no grenade data
 * at all. That makes the repopulate-after-respawn path load-bearing and, until
 * now, completely untested — the 2026-08 investigation into the LAN/NY1 "always
 * 0 grenades" reports found zero coverage anywhere in the suite.
 *
 * These tests pin the contract, NOT the bug: the NY1 root cause was server-side
 * (dodx read a wrong pdata offset, so a real `0` arrived over the wire). The
 * store's job is only to render what arrives and to re-populate after a respawn.
 *
 * Note the asymmetry deliberately asserted below: an absent player in a tick is
 * LEFT ALONE, while `nades: 0` is applied. That distinction is what lets the
 * plugin omit dead players from a snapshot without blanking their card.
 *
 * Mechanics mirror Socket.chaos.test.js / Socket.flags.test.js.
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
        event: 'player_spawn',
        user_id,
        team,
        class_id: 0,
        weapon_primary: 'garand',
        weapon_secondary: 'colt',
        health: 100,
    });
}

function playerState(emit, players) {
    emit('player_state', { event: 'player_state', players });
}

const find = (store, user_id) => {
    const { allies_players, axis_players } = store.getState();
    return [...allies_players, ...axis_players].find((p) => p.user_id === user_id);
};

describe('player_state → nades', () => {
    test('spawn leaves nades unknown (null) until the first snapshot lands', () => {
        const { store, emit } = setup();
        spawn(emit);

        // Not 0 — "we have not been told yet" is a different state from "empty",
        // even though the card currently renders both as a dimmed 0.
        expect(find(store, RIFLE).nades).toBeNull();
    });

    test('a snapshot populates the count', () => {
        const { store, emit } = setup();
        spawn(emit);
        playerState(emit, [{ user_id: RIFLE, weapon: 'garand', nades: 2, health: 100, prone_state: 'standing' }]);

        expect(find(store, RIFLE).nades).toBe(2);
        expect(find(store, RIFLE).weapon_active).toBe('garand');
    });

    test('a real zero is applied, not ignored', () => {
        const { store, emit } = setup();
        spawn(emit);
        playerState(emit, [{ user_id: RIFLE, weapon: 'garand', nades: 2, health: 100, prone_state: 'standing' }]);
        playerState(emit, [{ user_id: RIFLE, weapon: 'garand', nades: 0, health: 100, prone_state: 'standing' }]);

        expect(find(store, RIFLE).nades).toBe(0);
    });

    test('death clears it and the next spawn re-populates from a fresh snapshot', () => {
        const { store, emit } = setup();
        spawn(emit);
        playerState(emit, [{ user_id: RIFLE, weapon: 'garand', nades: 2, health: 100, prone_state: 'standing' }]);

        emit('kill', {
            event: 'kill', killer_id: 'STEAM_0:0:2002', victim_id: RIFLE,
            weapon: 'kar', kill_type: 'normal', kill_class: 'gun',
        });
        expect(find(store, RIFLE).nades).toBeNull();
        expect(find(store, RIFLE).dead).toBe(true);

        // The respawn path is the one that mattered in the field reports.
        spawn(emit);
        expect(find(store, RIFLE).nades).toBeNull();
        playerState(emit, [{ user_id: RIFLE, weapon: 'garand', nades: 2, health: 100, prone_state: 'standing' }]);
        expect(find(store, RIFLE).nades).toBe(2);
        expect(find(store, RIFLE).dead).toBe(false);
    });

    test('players omitted from a tick keep their value (dead players are omitted, not blanked)', () => {
        const { store, emit } = setup();
        const other = 'STEAM_0:0:3003';
        spawn(emit, RIFLE, 'allies');
        spawn(emit, other, 'allies');
        playerState(emit, [
            { user_id: RIFLE, weapon: 'garand', nades: 2, health: 100, prone_state: 'standing' },
            { user_id: other, weapon: 'bar', nades: 1, health: 100, prone_state: 'standing' },
        ]);

        // Only one player in this tick — the plugin skips dead players entirely.
        playerState(emit, [{ user_id: RIFLE, weapon: 'garand', nades: 1, health: 100, prone_state: 'standing' }]);

        expect(find(store, RIFLE).nades).toBe(1);
        expect(find(store, other).nades).toBe(1);
    });

    test('a snapshot for an unknown user_id does not create a phantom player', () => {
        const { store, emit } = setup();
        spawn(emit);
        playerState(emit, [{ user_id: 'STEAM_0:0:9999', weapon: 'kar', nades: 3, health: 100, prone_state: 'standing' }]);

        const { allies_players, axis_players } = store.getState();
        expect([...allies_players, ...axis_players].map((p) => p.user_id)).toEqual([RIFLE]);
    });

    test('a malformed snapshot is ignored rather than throwing', () => {
        const { store, emit } = setup();
        spawn(emit);
        playerState(emit, [{ user_id: RIFLE, weapon: 'garand', nades: 2, health: 100, prone_state: 'standing' }]);

        emit('player_state', { event: 'player_state' });                 // no players array
        emit('player_state', { event: 'player_state', players: 'nope' }); // wrong type

        expect(find(store, RIFLE).nades).toBe(2);
    });
});
