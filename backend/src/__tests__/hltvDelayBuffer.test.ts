/**
 * HltvDelayBuffer unit tests
 *
 * Asserts the per-server reorder queue releases events at the wall-clock
 * instant HLTV's broadcast clock catches up to each event's tick. Uses a
 * fake HltvSyncService stub so we can drive the broadcast clock by hand.
 */
import { HltvDelayBuffer, BufferedEvent, FireCallback } from '../handler/hltvDelayBuffer';
import type { HltvSyncService, ClockBasis } from '../handler/hltvSync';

// Lightweight stub matching the subset of HltvSyncService the buffer uses.
class StubSync {
    private clocks = new Map<string, number | null>();
    private delays = new Map<string, number | null>();
    private basis = new Map<string, ClockBasis | null>();
    private lag = 0;
    constructor(private fallback: number = 60) {}
    setBroadcastNow(server: string, value: number | null): void { this.clocks.set(server, value); }
    setDelaySeconds(server: string, value: number | null): void { this.delays.set(server, value); }
    setResetBasis(server: string, value: ClockBasis | null): void { this.basis.set(server, value); }
    setBoardLag(seconds: number): void { this.lag = seconds; }
    isActive(_server: string): boolean { return true; }
    broadcastNow(server: string, _now?: number): number | null { return this.clocks.get(server) ?? null; }
    fallbackDelaySeconds(): number { return this.fallback; }
    delaySeconds(server: string): number | null { return this.delays.get(server) ?? null; }
    tailBasis(server: string): ClockBasis | null { return this.basis.get(server) ?? null; }
    boardReleaseLagSeconds(): number { return this.lag; }
    oldEpochTick(_server: string, tick: number): boolean { return this.oldEpochTicks.has(tick); }
    private oldEpochTicks = new Set<number>();
    markOldEpochTick(tick: number): void { this.oldEpochTicks.add(tick); }
}

function makeBuffer(stub: StubSync, onFire: FireCallback = () => {}): HltvDelayBuffer {
    return new HltvDelayBuffer(stub as unknown as HltvSyncService, onFire);
}

function evt(tick: number, name: string = 'kill'): any {
    return { event: name, tick };
}

describe('HltvDelayBuffer', () => {

    it('holds events while broadcast clock is below their tick', () => {
        const stub = new StubSync();
        const fired: BufferedEvent[] = [];
        const buf = makeBuffer(stub, (e) => fired.push(e));

        stub.setBroadcastNow('atl1', 100);
        buf.enqueue({ server: 'atl1', event: evt(150), enqueuedAt: Date.now() });

        // Drive a tick manually
        (buf as any).tick();
        expect(fired).toHaveLength(0);

        stub.setBroadcastNow('atl1', 160);
        (buf as any).tick();
        expect(fired).toHaveLength(1);
        expect(fired[0].event.tick).toBe(150);
    });

    it('preserves tick order across out-of-order arrivals from the same server', () => {
        const stub = new StubSync();
        const fired: number[] = [];
        const buf = makeBuffer(stub, (e) => fired.push(e.event.tick));

        stub.setBroadcastNow('atl1', 0);
        buf.enqueue({ server: 'atl1', event: evt(105), enqueuedAt: Date.now() });
        buf.enqueue({ server: 'atl1', event: evt(100), enqueuedAt: Date.now() });
        buf.enqueue({ server: 'atl1', event: evt(110), enqueuedAt: Date.now() });

        stub.setBroadcastNow('atl1', 200);
        (buf as any).tick();
        expect(fired).toEqual([100, 105, 110]);
    });

    it('keeps two servers independent', () => {
        const stub = new StubSync();
        const fired: { s: string; t: number }[] = [];
        const buf = makeBuffer(stub, (e) => fired.push({ s: e.server, t: e.event.tick }));

        stub.setBroadcastNow('atl1', 0);
        stub.setBroadcastNow('den5', 0);
        buf.enqueue({ server: 'atl1', event: evt(50), enqueuedAt: Date.now() });
        buf.enqueue({ server: 'den5', event: evt(50), enqueuedAt: Date.now() });

        // Advance only atl1
        stub.setBroadcastNow('atl1', 100);
        (buf as any).tick();
        expect(fired.map(f => f.s)).toEqual(['atl1']);

        stub.setBroadcastNow('den5', 100);
        (buf as any).tick();
        expect(fired.map(f => f.s)).toEqual(['atl1', 'den5']);
    });

    it('with no clock yet, releases via fallback delay after enqueuedAt elapses', () => {
        const stub = new StubSync(2); // 2 second fallback for testability
        const fired: BufferedEvent[] = [];
        const buf = makeBuffer(stub, (e) => fired.push(e));

        // No broadcastNow set for 'atl1' — returns null
        const enqueuedAt = Date.now() - 3000; // pretend it was queued 3s ago
        buf.enqueue({ server: 'atl1', event: evt(50), enqueuedAt });
        (buf as any).tick();
        expect(fired).toHaveLength(1);
    });

    // Regression test: a failed RCON sample used to install a placeholder
    // HltvClock with activeTime=0 + delaySeconds=fallback, which made
    // broadcastNow return a negative number. The buffer's `tick <= broadcastNow`
    // check then never released any positive-tick event — every plugin event
    // sat in the queue forever. broadcastNow now returns null when the clock
    // is offline, routing the buffer to the fallback-delay path instead.
    it('treats null broadcastNow (offline HLTV with stale clock) as fallback path', () => {
        const stub = new StubSync(2); // 2 second fallback for testability
        const fired: BufferedEvent[] = [];
        const buf = makeBuffer(stub, (e) => fired.push(e));

        // Offline HLTV: stub returns null even though there's been a "sample".
        // This is what HltvSyncService.broadcastNow() now does for online=false.
        stub.setBroadcastNow('atl1', null);

        const enqueuedAt = Date.now() - 3000; // queued 3s ago, > 2s fallback
        buf.enqueue({ server: 'atl1', event: evt(150), enqueuedAt });
        (buf as any).tick();
        expect(fired).toHaveLength(1);
        expect(fired[0].event.tick).toBe(150);
    });

    // At a map change, old-map events (tick > new activeTime) used to fire
    // INSTANTLY — collapsing the broadcast delay at the boundary. They now go
    // to the wall-clock drain queue and release on their original delay.
    it('releaseStrandedEvents moves old-map events to the delayed drain (not instant), released in order', () => {
        const stub = new StubSync(2); // 2s drain delay (via fallback; no delaySeconds set)
        const fired: number[] = [];
        const buf = makeBuffer(stub, (e) => fired.push(e.event.tick));

        // Old-map events queued 3s ago (releaseAt = +2s → already due), plus a
        // legit low-tick new-map event that must stay in the main queue.
        const past = Date.now() - 3000;
        stub.setBroadcastNow('atl1', 1000);
        buf.enqueue({ server: 'atl1', event: evt(1100), enqueuedAt: past });
        buf.enqueue({ server: 'atl1', event: evt(1150), enqueuedAt: past + 10 });
        buf.enqueue({ server: 'atl1', event: evt(5),    enqueuedAt: Date.now() });

        buf.releaseStrandedEvents('atl1', 10);
        stub.setBroadcastNow('atl1', 0); // new low clock after the map change
        expect(fired).toEqual([]);                // NOT fired instantly
        expect(buf.queueDepth('atl1')).toBe(3);   // 1 main + 2 draining

        // Driver: drain releases the two old events in order; tick=5 is held
        // (broadcast clock 0 < 5).
        (buf as any).tick();
        expect(fired).toEqual([1100, 1150]);
        expect(buf.queueDepth('atl1')).toBe(1);
    });

    // Regression for the boundary-delay-collapse bug: at half-2 / OT / next-map
    // changelevel, the plugin's tick resets from ~1300s to ~1-90s. The old
    // half-1 tail must NOT flush instantly (HLTV hasn't broadcast it yet under
    // the ~60s delay) — it moves to the wall-clock drain and replays on the
    // broadcast delay, staying aligned with the feed across the boundary.
    it('moves the old-half tail to the delayed drain on a tick reset (not instant)', () => {
        const stub = new StubSync(2);
        const fired: number[] = [];
        const buf = makeBuffer(stub, (e) => fired.push(e.event.tick));

        const past = Date.now() - 3000;
        stub.setBroadcastNow('atl1', 1000);
        buf.enqueue({ server: 'atl1', event: evt(1100), enqueuedAt: past });
        buf.enqueue({ server: 'atl1', event: evt(1200), enqueuedAt: past + 10 });
        expect(buf.queueDepth('atl1')).toBe(2);

        // Half-2 starts: first event arrives with tick well below the tail.
        stub.setBroadcastNow('atl1', 0); // new low clock
        buf.enqueue({ server: 'atl1', event: evt(5), enqueuedAt: Date.now() });

        // Old-half events NOT fired instantly — moved to the delayed drain.
        expect(fired).toEqual([]);
        expect(buf.queueDepth('atl1')).toBe(3); // 2 draining + 1 main

        // Driver: drain releases the old tail in order; tick=5 held (broadcast 0).
        (buf as any).tick();
        expect(fired).toEqual([1100, 1200]);
        expect(buf.queueDepth('atl1')).toBe(1);
    });

    it('drains the old-map tail via the pre-reset broadcast-clock projection', () => {
        const stub = new StubSync(60);     // fallback 60s — would NOT fire in-window
        const now = Date.now();
        // Pre-reset basis: sampled 3s ago at gameTime 1100, 2s broadcast delay.
        // tick-1100 → releaseAt = (now-3000) + (1100-1100+2)*1000 = now-1000 → due.
        stub.setResetBasis('atl1', { activeTime: 1100, sampledAt: now - 3000, delaySeconds: 2, calibrationOffsetMs: 0 });
        const fired: number[] = [];
        const buf = makeBuffer(stub, (e) => fired.push(e.event.tick));

        stub.setBroadcastNow('atl1', 1000);
        buf.enqueue({ server: 'atl1', event: evt(1100), enqueuedAt: now });
        stub.setBroadcastNow('atl1', 0);
        buf.enqueue({ server: 'atl1', event: evt(5), enqueuedAt: now }); // reset → drainTail projects off basis

        (buf as any).tick();
        expect(fired).toEqual([1100]); // released by projection, not held for the 60s fallback
    });

    // The old formula anchored release to POST arrival (enqueuedAt + delay), so a
    // curl-stalled board POST landing late compounded into a very late board.
    // The projection anchors to the event's game-time tick instead.
    it('anchors drain release to the event tick, not POST arrival time', () => {
        const stub = new StubSync(60);
        const now = Date.now();
        // Board's true half-end tick projects to now-500 (already due) regardless
        // of when its POST arrived. Simulate a curl-stalled POST landing "now".
        stub.setResetBasis('atl1', { activeTime: 1200, sampledAt: now - 2500, delaySeconds: 2, calibrationOffsetMs: 0 });
        const fired: number[] = [];
        const buf = makeBuffer(stub, (e) => fired.push(e.event.tick));

        stub.setBroadcastNow('atl1', 1000);
        buf.enqueue({ server: 'atl1', event: evt(1200, 'player_stats_summary'), enqueuedAt: now }); // "late" arrival
        stub.setBroadcastNow('atl1', 0);
        buf.enqueue({ server: 'atl1', event: evt(5), enqueuedAt: now });

        (buf as any).tick();
        expect(fired).toEqual([1200]); // fires now — projected instant already passed; arrival ignored
    });

    // Proves the release tracks the live broadcast delay dynamically (no static
    // cap): the same tail with a larger pre-reset delay is held proportionally longer.
    it('drain follows the pre-reset broadcast delay — a larger delay holds longer', () => {
        const now = Date.now();
        const drainWith = (delay: number) => {
            const stub = new StubSync(9999);
            // Basis sampled 65s ago. tick-1200 → releaseAt = (now-65000) + delay*1000.
            //   delay 60 → now-5000 (due);  delay 90 → now+25000 (held).
            stub.setResetBasis('atl1', { activeTime: 1200, sampledAt: now - 65000, delaySeconds: delay, calibrationOffsetMs: 0 });
            const fired: number[] = [];
            const buf = makeBuffer(stub, (e) => fired.push(e.event.tick));
            stub.setBroadcastNow('atl1', 1000);
            buf.enqueue({ server: 'atl1', event: evt(1200), enqueuedAt: now });
            stub.setBroadcastNow('atl1', 0);
            buf.enqueue({ server: 'atl1', event: evt(5), enqueuedAt: now });
            (buf as any).tick();
            return fired;
        };
        expect(drainWith(60)).toEqual([1200]); // 60s delay already elapsed → due
        expect(drainWith(90)).toEqual([]);     // 90s delay not yet elapsed → held
    });

    it('applies the board late-bias only to board events at a changelevel', () => {
        const stub = new StubSync(9999);
        const now = Date.now();
        // Basis sampled 3s ago at gameTime 1200, delay 2. tick-1200 → releaseAt
        // now-1000 (due). A 5s board lag pushes board events to now+4000 (held).
        stub.setResetBasis('atl1', { activeTime: 1200, sampledAt: now - 3000, delaySeconds: 2, calibrationOffsetMs: 0 });
        stub.setBoardLag(5);
        const fired: string[] = [];
        const buf = makeBuffer(stub, (e) => fired.push(e.event.event));

        stub.setBroadcastNow('atl1', 1000);
        buf.enqueue({ server: 'atl1', event: evt(1200, 'kill'), enqueuedAt: now });
        buf.enqueue({ server: 'atl1', event: evt(1200, 'player_stats_summary'), enqueuedAt: now });
        stub.setBroadcastNow('atl1', 0);
        buf.enqueue({ server: 'atl1', event: evt(5), enqueuedAt: now }); // reset → drain both high-tick events

        (buf as any).tick();
        // Gameplay tail (kill) fires at the projection; the board is held by the +5s lag.
        expect(fired).toEqual(['kill']);
        expect(buf.queueDepth('atl1')).toBe(2); // board draining + tick-5 main
    });

    it('treats match_phase as a board event so HALFTIME cannot precede its board', () => {
        // The halftime match_phase is emitted from ktp_half_end — the same
        // old-map tail as the halftime board. Without the late-bias it releases
        // first and announces HALFTIME over footage that is still live.
        const stub = new StubSync(9999);
        const now = Date.now();
        stub.setResetBasis('atl1', { activeTime: 1200, sampledAt: now - 3000, delaySeconds: 2, calibrationOffsetMs: 0 });
        stub.setBoardLag(5);
        const fired: string[] = [];
        const buf = makeBuffer(stub, (e) => fired.push(e.event.event));

        stub.setBroadcastNow('atl1', 1000);
        buf.enqueue({ server: 'atl1', event: evt(1200, 'kill'), enqueuedAt: now });
        buf.enqueue({ server: 'atl1', event: evt(1200, 'match_phase'), enqueuedAt: now });
        stub.setBroadcastNow('atl1', 0);
        buf.enqueue({ server: 'atl1', event: evt(5), enqueuedAt: now });

        (buf as any).tick();
        expect(fired).toEqual(['kill']);
        expect(buf.queueDepth('atl1')).toBe(2); // match_phase held in draining
    });

    // The +TICK_RESET_THRESHOLD_S margin in releaseStrandedEvents must not
    // mis-strand a fresh new-map event sitting just above the freshly-sampled
    // activeTime (which would project to a past releaseAt and fire early).
    it('releaseStrandedEvents keeps fresh events within the reset threshold of activeTime', () => {
        const stub = new StubSync(2);
        const now = Date.now();
        const fired: number[] = [];
        const buf = makeBuffer(stub, (e) => fired.push(e.event.tick));

        stub.setBroadcastNow('atl1', 1000);
        buf.enqueue({ server: 'atl1', event: evt(1100), enqueuedAt: now - 3000 }); // old-map → should strand
        buf.enqueue({ server: 'atl1', event: evt(20),   enqueuedAt: now });        // fresh → just above activeTime

        // New sample: activeTime 10. Margin 30 → strand only tick > 40.
        buf.releaseStrandedEvents('atl1', 10);
        expect(buf.queueDepth('atl1')).toBe(2); // 1100 drained, tick-20 stays in main

        stub.setBroadcastNow('atl1', 0);
        (buf as any).tick();
        expect(fired).toEqual([1100]); // old-map drained (fallback: now-3000+2000 due); fresh tick-20 held

        // The fresh event releases normally once the broadcast clock reaches its tick.
        stub.setBroadcastNow('atl1', 25);
        (buf as any).tick();
        expect(fired).toEqual([1100, 20]);
    });

    // Bug 1 non-regression: a fresh low-tick event whose broadcast clock would
    // release it immediately must NOT overtake the still-draining old-map tail.
    it('gates new-map events until the old-map drain empties (ordering)', () => {
        const stub = new StubSync(60);
        stub.setDelaySeconds('atl1', 10); // long drain delay so the tail stays pending
        const fired: number[] = [];
        const buf = makeBuffer(stub, (e) => fired.push(e.event.tick));

        stub.setBroadcastNow('atl1', 1000);
        buf.enqueue({ server: 'atl1', event: evt(1100), enqueuedAt: Date.now() }); // releaseAt = +10s (future)
        // Reset: new low-tick event (the next-map ktp_match_start analogue).
        buf.enqueue({ server: 'atl1', event: evt(5), enqueuedAt: Date.now() });
        stub.setBroadcastNow('atl1', 1000); // new clock "ahead" — tick=5 <= 1000 would fire if not gated

        (buf as any).tick();
        // Nothing fires: drain (1100) not due (10s), and the main queue is GATED
        // while draining is non-empty, so tick=5 does not jump ahead of the tail.
        expect(fired).toEqual([]);
        expect(buf.queueDepth('atl1')).toBe(2);
    });

    it('stacked resets (h1->h2->OT) keep old-map events FIFO by release time', () => {
        const stub = new StubSync(2);
        const fired: number[] = [];
        const buf = makeBuffer(stub, (e) => fired.push(e.event.tick));

        const t = Date.now() - 3000;
        stub.setBroadcastNow('atl1', 1000);
        // half-1 tail
        buf.enqueue({ server: 'atl1', event: evt(1100), enqueuedAt: t });
        buf.enqueue({ server: 'atl1', event: evt(1200), enqueuedAt: t + 10 });
        // reset to half-2 (tick 5) → moves [1100,1200] to drain
        stub.setBroadcastNow('atl1', 0);
        buf.enqueue({ server: 'atl1', event: evt(5),  enqueuedAt: t + 20 });
        buf.enqueue({ server: 'atl1', event: evt(40), enqueuedAt: t + 30 }); // half-2 event in main
        // reset to OT (tick 3) → moves [5,40] to drain too
        buf.enqueue({ server: 'atl1', event: evt(3),  enqueuedAt: t + 40 });

        (buf as any).tick();
        // All old-map events drain FIFO by releaseAt; tick=3 (new OT) held (broadcast 0).
        expect(fired).toEqual([1100, 1200, 5, 40]);
        expect(buf.queueDepth('atl1')).toBe(1);
    });

    it('keeps two servers drains independent', () => {
        const stub = new StubSync(2);
        const fired: string[] = [];
        const buf = makeBuffer(stub, (e) => fired.push(`${e.server}:${e.event.tick}`));

        const past = Date.now() - 3000;
        stub.setBroadcastNow('atl1', 1000);
        stub.setBroadcastNow('den5', 1000);
        buf.enqueue({ server: 'atl1', event: evt(1100), enqueuedAt: past });        // due (3s ago)
        buf.enqueue({ server: 'den5', event: evt(1100), enqueuedAt: Date.now() });  // not due (just now)
        // reset both servers
        stub.setBroadcastNow('atl1', 0);
        stub.setBroadcastNow('den5', 0);
        buf.enqueue({ server: 'atl1', event: evt(5), enqueuedAt: Date.now() });
        buf.enqueue({ server: 'den5', event: evt(5), enqueuedAt: Date.now() });

        (buf as any).tick();
        // Only atl1's old tail is due; den5's is still within its 2s drain delay.
        expect(fired).toEqual(['atl1:1100']);
    });

    // A late old-epoch POST must never enter the main queue: as the highest-
    // tick tail it would make the next fresh event mis-trigger the tick-reset
    // and drain fresh events against the wrong basis.
    it('routes old-epoch stragglers straight to the drain, leaving the main queue clean', () => {
        const stub = new StubSync(9999);
        const now = Date.now();
        stub.setResetBasis('atl1', { activeTime: 1200, sampledAt: now - 3000, delaySeconds: 2, calibrationOffsetMs: 0 });
        stub.markOldEpochTick(1195);
        const fired: number[] = [];
        const buf = makeBuffer(stub, (e) => fired.push(e.event.tick));

        // Fresh half-2 events in the main queue.
        stub.setBroadcastNow('atl1', 0);
        buf.enqueue({ server: 'atl1', event: evt(5),  enqueuedAt: now });
        buf.enqueue({ server: 'atl1', event: evt(12), enqueuedAt: now });
        // Straggler arrives late — goes to the drain (projected releaseAt
        // = (now-3000) + (1195-1200+2)*1000 = now-6000 → already due).
        buf.enqueue({ server: 'atl1', event: evt(1195), enqueuedAt: now });
        // A subsequent fresh event must NOT see a high-tick tail (no reset).
        buf.enqueue({ server: 'atl1', event: evt(13), enqueuedAt: now });

        (buf as any).tick();
        // Straggler fired from the drain; fresh events held by the (low) clock.
        expect(fired).toEqual([1195]);
        expect(buf.queueDepth('atl1')).toBe(3);
        stub.setBroadcastNow('atl1', 20);
        (buf as any).tick();
        expect(fired).toEqual([1195, 5, 12, 13]); // order intact — queue never drained wholesale
    });

    it('does not flush on small tick jitter from out-of-order arrivals', () => {
        const stub = new StubSync();
        const fired: number[] = [];
        const buf = makeBuffer(stub, (e) => fired.push(e.event.tick));

        stub.setBroadcastNow('atl1', 0);
        buf.enqueue({ server: 'atl1', event: evt(100), enqueuedAt: Date.now() });
        buf.enqueue({ server: 'atl1', event: evt(110), enqueuedAt: Date.now() });
        // 5s out-of-order arrival — far below the 30s reset threshold.
        buf.enqueue({ server: 'atl1', event: evt(105), enqueuedAt: Date.now() });

        expect(fired).toEqual([]);
        expect(buf.queueDepth('atl1')).toBe(3);
    });

    it('start/stop drives a setInterval', () => {
        const stub = new StubSync();
        const buf = makeBuffer(stub);
        buf.start();
        // The driver is private, just verify start/stop don't throw.
        buf.stop();
    });

});
