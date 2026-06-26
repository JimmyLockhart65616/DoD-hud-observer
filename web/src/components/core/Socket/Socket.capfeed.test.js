/**
 * Frontend cap-feed attribution tests
 *
 * The plugin now defers flag_captured until dod_score_event has filled the
 * captor batch, so captor_ids arrives POPULATED (previously always []). The
 * cap feed (FlagFeed.jsx) renders captor names from the resolved `captors`
 * array. These tests drive the real flag_captured handler through the shared
 * gameEvents bus and assert the resolver:
 *   - resolves captor_ids to roster names
 *   - falls back to the raw steam id + capturing team when a captor isn't in
 *     the roster yet (otherwise .filter(Boolean) would drop a nameless captor)
 *   - tolerates the legacy empty captor_ids shape without dropping the cap
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

function connect(emit, id, name, team) {
    emit('player_connect', { event: 'player_connect', user_id: id, name, team });
}
function capture(emit, flag_id, flag_name, new_owner, captor_ids) {
    emit('flag_captured', { event: 'flag_captured', flag_id, flag_name, new_owner, captor_ids });
}
function lastFlag(store) {
    const feed = store.getState().flag_feed;
    return feed[feed.length - 1];
}

describe('Socket store machine — cap feed captor attribution', () => {

    it('resolves captor_ids to roster names', () => {
        const { store, emit } = setup();
        connect(emit, 'STEAM_0:0:1', 'Alpha', 'allies');
        connect(emit, 'STEAM_0:0:2', 'Bravo', 'allies');

        capture(emit, 0, 'POINT_ANZIO_LAUNDRY', 'allies', ['STEAM_0:0:1', 'STEAM_0:0:2']);

        const entry = lastFlag(store);
        expect(entry.kind).toBe('captured');
        expect(entry.new_owner).toBe('allies');
        expect(entry.captors.map(c => c.name)).toEqual(['Alpha', 'Bravo']);
    });

    it('falls back to steam id + capturing team for an unresolved captor', () => {
        const { store, emit } = setup();
        // No player_connect for this id — simulates a late join / pre-connect cap.
        capture(emit, 1, 'POINT_BRIDGE', 'axis', ['STEAM_0:0:999']);

        const entry = lastFlag(store);
        expect(entry.captors).toEqual([{ name: 'STEAM_0:0:999', team: 'axis' }]);
    });

    it('mixes resolved + fallback captors without dropping either', () => {
        const { store, emit } = setup();
        connect(emit, 'STEAM_0:0:1', 'Alpha', 'allies');

        capture(emit, 2, 'POINT_ANZIO_STREET', 'allies', ['STEAM_0:0:1', 'STEAM_0:0:7']);

        const entry = lastFlag(store);
        expect(entry.captors.map(c => c.name)).toEqual(['Alpha', 'STEAM_0:0:7']);
    });

    it('tolerates the legacy empty captor_ids shape without dropping the cap', () => {
        const { store, emit } = setup();
        capture(emit, 3, 'POINT_ANZIO_PLAZA', 'allies', []);

        const entry = lastFlag(store);
        expect(entry.kind).toBe('captured');
        expect(entry.captors).toEqual([]);
    });
});

describe('Socket store machine — kill-on-point cap breaks', () => {

    function playerById(store, id) {
        return [...store.getState().allies_players, ...store.getState().axis_players]
            .find(p => p.user_id === id);
    }

    it('player_score cap_breaks lands in the store', () => {
        const { store, emit } = setup();
        connect(emit, 'STEAM_0:0:5', 'Defender', 'axis');
        emit('player_score', {
            event: 'player_score', user_id: 'STEAM_0:0:5',
            kills: 1, deaths: 0, score: 3, obj_score: 0, caps: 0, cap_breaks: 2,
        });
        expect(playerById(store, 'STEAM_0:0:5').cap_breaks).toBe(2);
    });

    it('cap_break event adds a kill-break feed entry with the breaker name', () => {
        const { store, emit } = setup();
        connect(emit, 'STEAM_0:0:5', 'Defender', 'axis');
        emit('cap_break', {
            event: 'cap_break', flag_id: 0, flag_name: 'POINT_ANZIO_LAUNDRY',
            reason: 'kill', breaker_id: 'STEAM_0:0:5', broke_team: 'allies',
        });
        const entry = lastFlag(store);
        expect(entry.kind).toBe('cap_break_kill');
        expect(entry.breaker_name).toBe('Defender');
        expect(entry.breaker_team).toBe('axis');
        expect(entry.broke_team).toBe('allies');
    });

    it('cap_break falls back to steam id + opposite team for an unresolved breaker', () => {
        const { store, emit } = setup();
        emit('cap_break', {
            event: 'cap_break', flag_id: 1, flag_name: 'POINT_BRIDGE',
            reason: 'kill', breaker_id: 'STEAM_0:0:88', broke_team: 'axis',
        });
        const entry = lastFlag(store);
        expect(entry.breaker_name).toBe('STEAM_0:0:88');
        expect(entry.breaker_team).toBe('allies'); // opposite of broke_team
    });
});