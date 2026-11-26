/* eslint-disable import/first */
jest.mock('socket.io-client', () => {
    const sock = { on: () => {}, onAny: () => {}, emit: () => {}, connect: () => {}, disconnect: () => {} };
    return { __esModule: true, default: { connect: () => sock, io: () => sock }, connect: () => sock, io: () => sock };
});

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import React from 'react';
import { render } from '@testing-library/react';
import { act } from 'react-dom/test-utils';
import { unstable_batchedUpdates } from 'react-dom';
import { SocketStoreComponent, useHudStore, resetHudState } from '../Socket/Socket';
import gameEvents from '../gameEvents';
import { hudNow, hudAfter, setHudClockSource } from '../clock/hudClock';
import { createReplayEngine } from './replayEngine';
import { replayTimeline, mergeOnClock } from './replayClock';
import { buildClockTimeline, findClock } from './demoClock';

afterEach(() => setHudClockSource(null));

describe('replay engine (pure)', () => {
    const events = [{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }];
    const clock = [1000, 1000, 4000, 9000];

    function engineWith(onEmit) {
        const seen = [];
        const engine = createReplayEngine({
            events, clock,
            emit: e => { seen.push({ n: e.n, at: hudNow() }); if (onEmit) onEmit(e); },
            reset: () => seen.push('reset'),
        });
        return { engine, seen };
    }

    it('stamps every event at its own instant however large the step', () => {
        const { engine, seen } = engineWith();
        engine.advanceTo(100000);
        expect(seen).toEqual([{ n: 0, at: 1000 }, { n: 1, at: 1000 }, { n: 2, at: 4000 }, { n: 3, at: 9000 }]);
        expect(engine.now).toBe(9000);   // clamped to the last event
        expect(engine.done).toBe(true);
    });

    it('holds time still between advances (a paused replay stops the HUD clock)', () => {
        const { engine } = engineWith();
        engine.advanceTo(2500);
        expect(hudNow()).toBe(2500);
        expect(hudNow()).toBe(2500);
    });

    it('fires a virtual timer in time order between events', () => {
        const { engine, seen } = engineWith(e => {
            if (e.n === 0) hudAfter(() => seen.push({ timer: true, at: hudNow() }), 5000);
        });
        engine.advanceTo(5999);
        expect(seen.some(x => x.timer)).toBe(false);
        engine.advanceTo(9000);
        expect(seen).toEqual([
            { n: 0, at: 1000 }, { n: 1, at: 1000 }, { n: 2, at: 4000 },
            { timer: true, at: 6000 },
            { n: 3, at: 9000 },
        ]);
    });

    it('seeks forward without a reset and backward by re-feeding from the start', () => {
        const { engine, seen } = engineWith();
        engine.seek(4000);
        expect(seen.filter(x => x === 'reset')).toHaveLength(0);
        engine.seek(1000);
        expect(seen.slice(3)).toEqual(['reset', { n: 0, at: 1000 }, { n: 1, at: 1000 }]);
        expect(engine.index).toBe(2);
    });

    it('gives the wall clock back on dispose', () => {
        const { engine } = engineWith();
        engine.dispose();
        expect(Math.abs(hudNow() - Date.now())).toBeLessThan(50);
    });
});

// The real store, fed a real archived two-half match.
const FIXTURE = path.resolve(__dirname, '../../../../../e2e/repro/fixtures/match-1783302239-CHI1.jsonl.gz');

function loadFixture() {
    const raw = zlib.gunzipSync(fs.readFileSync(FIXTURE)).toString();
    return raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
}

// React keys come from counters that only need to keep rising, so they differ
// between two feeds of the same events. Everything else must match.
function snapshot() {
    const s = useHudStore.getState();
    const data = Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v !== 'function'));
    return JSON.parse(JSON.stringify(data, (k, v) => (k === 'id' || k === 'last_damage_id' ? undefined : v)));
}

describe('replay engine against the store', () => {
    const events = loadFixture();
    const { clock, mapOf } = replayTimeline(events);

    // Mount the store ONCE per test (each mount adds its own bus listeners);
    // every engine starts from a reset HUD.
    beforeEach(() => { render(React.createElement(SocketStoreComponent)); });

    function mount() {
        resetHudState();
        return createReplayEngine({
            events, clock,
            emit: evt => gameEvents.emit(evt.event, JSON.stringify(evt)),
            reset: resetHudState,
            batch: unstable_batchedUpdates,
        });
    }

    it('lands on the same HUD state by seeking back and forth as by playing straight through', () => {
        const mid = clock[0] + (clock[clock.length - 1] - clock[0]) * 0.62;   // inside half 2

        let engine = mount();
        act(() => engine.advanceTo(mid));
        const straight = snapshot();
        engine.dispose();

        engine = mount();
        act(() => engine.seek(engine.end));
        act(() => engine.seek(clock[0] + 60000));    // back into half 1: full re-feed
        act(() => engine.seek(mid));                  // forward again
        const seeked = snapshot();
        engine.dispose();

        expect(straight.half).toBe(2);
        expect(seeked).toEqual(straight);
    });

    it('shows the typed demo clock on the overlay after a seek', () => {
        const timeline = buildClockTimeline(events, clock, mapOf);
        const engine = mount();
        [[2, 600], [1, 900], [2, 1199], [1, 30]].forEach(([half, seconds]) => {
            const v = findClock(timeline, half, seconds);
            act(() => engine.seek(v));
            const { timeleft, timeleft_at, half: storeHalf } = useHudStore.getState();
            // Timer.jsx's arithmetic, read at the engine's clock
            const shown = Math.max(0, Math.floor(timeleft - (hudNow() - timeleft_at) / 1000));
            expect({ half: storeHalf, shown }).toEqual({ half, shown: seconds });
        });
        engine.dispose();
    });

    it('revives the dead 5s of replay time after a round_end, not 5s of wall time', () => {
        const synthetic = [
            { event: 'player_connect', user_id: 'A', name: 'a', team: 'allies', tick: 1, plugin_sent_at: 10000 },
            { event: 'player_spawn', user_id: 'A', team: 'allies', class_id: 0, tick: 1, plugin_sent_at: 10000 },
            { event: 'kill', killer_id: 'B', victim_id: 'A', weapon: 'kar', kill_type: 'normal', tick: 2, plugin_sent_at: 11000 },
            { event: 'round_end', winner: 'axis', allies_score: 0, axis_score: 1, tick: 3, plugin_sent_at: 12000 },
            { event: 'time_sync', timeleft: 100, tick: 20, plugin_sent_at: 29000 },
        ];
        const t = replayTimeline(synthetic).clock;
        resetHudState();
        const engine = createReplayEngine({
            events: synthetic, clock: t,
            emit: evt => gameEvents.emit(evt.event, JSON.stringify(evt)),
            reset: resetHudState, batch: unstable_batchedUpdates,
        });
        const dead = () => useHudStore.getState().allies_players.find(p => p.user_id === 'A').dead;
        act(() => engine.advanceTo(t[3] + 4999));
        expect(dead()).toBe(true);
        act(() => engine.advanceTo(t[3] + 5000));
        expect(dead()).toBe(false);
        // and a seek straight past it applies it too
        act(() => engine.seek(t[0]));
        act(() => engine.seek(t[4]));
        expect(dead()).toBe(false);
        engine.dispose();
    });

    it('plays recorded player_state rows, stamped at their own replay instant', () => {
        const base = [
            { event: 'player_connect', user_id: 'A', name: 'a', team: 'allies', tick: 1, plugin_sent_at: 10000 },
            { event: 'player_spawn', user_id: 'A', team: 'allies', class_id: 0, weapon_primary: 'garand', tick: 1, plugin_sent_at: 10000 },
            { event: 'time_sync', timeleft: 100, tick: 30, plugin_sent_at: 39000 },
        ];
        const rows = [
            { event: 'player_state', tick: 4.25, plugin_sent_at: 13000,
              players: [{ user_id: 'A', weapon: 'colt', nades: 1, health: 77, prone_state: 'standing' }],
              waves: { allies: { in: 6.5, pending: 1 } } },
            { event: 'weapon_active', user_id: 'A', weapon: 'spade', tick: 9.0, plugin_sent_at: 18000 },
        ];
        const timeline = replayTimeline(base);
        const merged = mergeOnClock(base, timeline, rows);
        resetHudState();
        const engine = createReplayEngine({
            events: merged.events, clock: merged.clock,
            emit: evt => gameEvents.emit(evt.event, JSON.stringify(evt)),
            reset: resetHudState, batch: unstable_batchedUpdates,
        });
        const rowAt = merged.clock[merged.events.indexOf(rows[0])];
        act(() => engine.seek(rowAt + 1000));
        const s = useHudStore.getState();
        const a = s.allies_players.find(p => p.user_id === 'A');
        expect(a.weapon_active).toBe('colt');
        expect(a.nades).toBe(1);
        expect(s.wave_allies).toBe(6.5);
        expect(s.wave_allies_at).toBe(rowAt);          // not the wall clock at the seek
        act(() => engine.seek(merged.clock[merged.clock.length - 1]));
        expect(useHudStore.getState().allies_players.find(p => p.user_id === 'A').weapon_active).toBe('spade');
        engine.dispose();
    });
});
