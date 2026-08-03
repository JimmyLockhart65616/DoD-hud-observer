/**
 * Frontend store-machine tests — flag ownership
 *
 * Covers the `flags_init` reason gate, which is the frontend half of the
 * "flags don't reset at map start or after a capout" bug:
 *
 *   - The engine restores every CP to its map default at a round restart. The
 *     plugin emits no `flag_captured` for a team→neutral transition (a live flag
 *     never goes neutral mid-round, so those events are all restart noise), which
 *     makes the follow-up `flags_init` the ONLY carrier of the reset.
 *   - Before `reason` existed, the handler refused every team→neutral downgrade
 *     from a snapshot (4caaa75) because it could not tell a genuine reset from
 *     the 30s heartbeat landing mid-restart. So the reset never rendered and the
 *     bar kept the previous round's colours until ktp_match_start or a real cap.
 *
 * The gate keeps that protection for `tick` and drops it for the authoritative
 * reasons. A snapshot with NO reason (older plugin) must behave exactly as
 * before — that is what lets the frontend ship ahead of the plugin.
 *
 * Mechanics mirror Socket.chaos.test.js: socket.io-client is mocked at module
 * load, each test mounts a fresh component (RTL auto-unmounts between tests,
 * clearing gameEvents handlers) and drives the REAL handlers over the bus.
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

// dod_kalt's real layout, from its BSP point_default_owner keys:
// [allies, neutral, neutral, neutral, axis].
const KALT = [
    { flag_id: 0, flag_name: 'POINT_ALLIEDBUNKER', owner: 'allies' },
    { flag_id: 1, flag_name: 'POINT_ALLIEDSTREET', owner: 'neutral' },
    { flag_id: 2, flag_name: 'POINT_BRIDGE', owner: 'neutral' },
    { flag_id: 3, flag_name: 'POINT_AXISSTREET', owner: 'neutral' },
    { flag_id: 4, flag_name: 'POINT_AXISBUNKER', owner: 'axis' },
];

function flagsInit(emit, flags, reason) {
    const e = { event: 'flags_init', flags };
    if (reason !== undefined) e.reason = reason;
    emit('flags_init', e);
}

function captured(emit, flag_id, new_owner) {
    const flag = KALT.find(f => f.flag_id === flag_id);
    emit('flag_captured', {
        event: 'flag_captured', flag_id, flag_name: flag.flag_name,
        new_owner, captor_ids: ['STEAM_0:0:1'],
    });
}

function owners(store) {
    return store.getState().flags.map(f => f.owner);
}

describe('Socket store machine — flag ownership resets', () => {

    it('adopts the map defaults from a map_load snapshot', () => {
        const { store, emit } = setup();
        flagsInit(emit, KALT, 'map_load');
        expect(owners(store)).toEqual(['allies', 'neutral', 'neutral', 'neutral', 'axis']);
    });

    it('resets to defaults after a capout — the reset snapshot wins over cached owners', () => {
        const { store, emit } = setup();
        flagsInit(emit, KALT, 'map_load');

        // Allies cap out: every flag flips to allies.
        for (const id of [1, 2, 3, 4]) captured(emit, id, 'allies');
        expect(owners(store)).toEqual(['allies', 'allies', 'allies', 'allies', 'allies']);

        // Engine restart: three flags go back to neutral and the axis bunker back
        // to axis. The plugin emits nothing per-flag for the neutral transitions —
        // only this snapshot.
        flagsInit(emit, KALT, 'reset');
        expect(owners(store)).toEqual(['allies', 'neutral', 'neutral', 'neutral', 'axis']);
    });

    it('a tick heartbeat still cannot grey out a captured flag', () => {
        const { store, emit } = setup();
        flagsInit(emit, KALT, 'map_load');
        captured(emit, 2, 'axis');

        // The pre-halftime restart window makes dodx briefly report every CP
        // neutral; a heartbeat landing there must not wipe the bar (4caaa75).
        flagsInit(emit, KALT.map(f => ({ ...f, owner: 'neutral' })), 'tick');
        expect(owners(store)).toEqual(['allies', 'neutral', 'axis', 'neutral', 'axis']);
    });

    it('a reason-less snapshot (older plugin) keeps the legacy preserve behaviour', () => {
        const { store, emit } = setup();
        flagsInit(emit, KALT, 'map_load');
        captured(emit, 2, 'axis');

        flagsInit(emit, KALT.map(f => ({ ...f, owner: 'neutral' })), undefined);
        expect(owners(store)).toEqual(['allies', 'neutral', 'axis', 'neutral', 'axis']);
    });

    it('a tick snapshot still applies team→team and neutral→team changes', () => {
        const { store, emit } = setup();
        flagsInit(emit, KALT, 'map_load');

        // Only downgrades to neutral are refused on a tick; everything else is
        // adopted, so a missed flag_captured still heals within 30s.
        flagsInit(emit, [
            { ...KALT[0], owner: 'axis' },     // team -> team
            { ...KALT[1], owner: 'allies' },   // neutral -> team
            KALT[2], KALT[3], KALT[4],
        ], 'tick');
        expect(owners(store)).toEqual(['axis', 'allies', 'neutral', 'neutral', 'axis']);
    });

    it('a fresh match clears flags so the next map_load adopts its own defaults', () => {
        const { store, emit } = setup();
        flagsInit(emit, KALT, 'map_load');
        captured(emit, 1, 'allies');

        // resetMatch seeds flags: [] — nothing is carried into the new map, so
        // even a tick snapshot lands verbatim.
        emit('ktp_match_start', { event: 'ktp_match_start', half: 2 });
        expect(store.getState().flags).toEqual([]);

        flagsInit(emit, KALT.map(f => ({ ...f, owner: 'neutral' })), 'tick');
        expect(owners(store)).toEqual(['neutral', 'neutral', 'neutral', 'neutral', 'neutral']);
    });
});
