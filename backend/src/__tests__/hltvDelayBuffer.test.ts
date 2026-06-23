/**
 * HltvDelayBuffer unit tests
 *
 * Asserts the per-server reorder queue releases events at the wall-clock
 * instant HLTV's broadcast clock catches up to each event's tick. Uses a
 * fake HltvSyncService stub so we can drive the broadcast clock by hand.
 */
import { HltvDelayBuffer, BufferedEvent, FireCallback } from '../handler/hltvDelayBuffer';
import type { HltvSyncService } from '../handler/hltvSync';

// Lightweight stub matching the subset of HltvSyncService the buffer uses.
class StubSync {
    private clocks = new Map<string, number | null>();
    private delays = new Map<string, number | null>();
    constructor(private fallback: number = 60) {}
    setBroadcastNow(server: string, value: number | null): void { this.clocks.set(server, value); }
    setDelaySeconds(server: string, value: number | null): void { this.delays.set(server, value); }
    isActive(_server: string): boolean { return true; }
    broadcastNow(server: string, _now?: number): number | null { return this.clocks.get(server) ?? null; }
    fallbackDelaySeconds(): number { return this.fallback; }
    delaySeconds(server: string): number | null { return this.delays.get(server) ?? null; }
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

    it('drain uses the server delaySeconds (captured at reset), not the fallback', () => {
        const stub = new StubSync(60);     // fallback 60s — would NOT fire in-window
        stub.setDelaySeconds('atl1', 2);   // real broadcast delay 2s — SHOULD fire
        const fired: number[] = [];
        const buf = makeBuffer(stub, (e) => fired.push(e.event.tick));

        const past = Date.now() - 3000;    // 3s ago: > 2s delay, < 60s fallback
        stub.setBroadcastNow('atl1', 1000);
        buf.enqueue({ server: 'atl1', event: evt(1100), enqueuedAt: past });
        stub.setBroadcastNow('atl1', 0);
        buf.enqueue({ server: 'atl1', event: evt(5), enqueuedAt: Date.now() }); // reset → drainTail uses delaySeconds=2

        (buf as any).tick();
        expect(fired).toEqual([1100]); // released because 3s elapsed > 2s delay (not held for 60s)
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
