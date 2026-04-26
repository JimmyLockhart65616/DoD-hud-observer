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
    constructor(private fallback: number = 60) {}
    setBroadcastNow(server: string, value: number | null): void { this.clocks.set(server, value); }
    isActive(_server: string): boolean { return true; }
    broadcastNow(server: string, _now?: number): number | null { return this.clocks.get(server) ?? null; }
    fallbackDelaySeconds(): number { return this.fallback; }
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

    it('releaseStrandedEvents flushes only events whose tick exceeds new activeTime', () => {
        const stub = new StubSync();
        const fired: number[] = [];
        const buf = makeBuffer(stub, (e) => fired.push(e.event.tick));

        // Simulate a backwards clock jump: enqueue events with old-map ticks,
        // then a sample arrives with a small activeTime (new map).
        stub.setBroadcastNow('atl1', 1000);
        buf.enqueue({ server: 'atl1', event: evt(1100), enqueuedAt: Date.now() });
        buf.enqueue({ server: 'atl1', event: evt(1150), enqueuedAt: Date.now() });
        buf.enqueue({ server: 'atl1', event: evt(5),    enqueuedAt: Date.now() });

        // Pretend HLTV reported activeTime = 10 (new map just started).
        // The two old-map events (tick=1100, 1150) must flush; the small-tick
        // event (tick=5) is legitimately on the new clock and stays queued.
        buf.releaseStrandedEvents('atl1', 10);
        expect(fired.sort()).toEqual([1100, 1150]);
        expect(buf.queueDepth('atl1')).toBe(1);
    });

    it('start/stop drives a setInterval', () => {
        const stub = new StubSync();
        const buf = makeBuffer(stub);
        buf.start();
        // The driver is private, just verify start/stop don't throw.
        buf.stop();
    });

});
