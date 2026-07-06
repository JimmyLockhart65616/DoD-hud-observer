/**
 * wireStrandedRescue — ordering regressions for the rescue path.
 *
 * These pin the temporal couplings the live rig caught that per-component
 * stubs missed (see hltvHarness.ts header). The critical one: a heartbeat can
 * land mid-changelevel and strand the old tail BEFORE any new-map ingest
 * event has promoted the reset basis — the drain must then project off the
 * last-event snapshot, not fall back to arrival+fallback (run-2 rig bug).
 *
 * Time model: HLTV Delay is deliberately ≠ fallback_delay_seconds in the
 * discriminating tests, so a wrong code path lands at a visibly different
 * wall-clock instant than the projection.
 */
import {
    makeHarness, runTimeline, advance, flushMicrotasks, SERVER, Harness, EventToken,
} from './helpers/hltvHarness';

function firedAt(h: Harness, token: EventToken): number {
    const f = h.fired.find(x => x.id === token.id);
    if (!f) throw new Error(`event never fired: ${token.name} tick=${token.tick}`);
    return f.firedAt;
}

function expectWithin(actual: number, expected: number, beforeMs: number, afterMs: number): void {
    expect(actual).toBeGreaterThanOrEqual(expected - beforeMs);
    expect(actual).toBeLessThanOrEqual(expected + afterMs);
}

describe('wireStrandedRescue — rescue-path ordering', () => {
    let h: Harness | null = null;

    beforeEach(() => {
        // doNotFake: performance is read-only on newer Node — sinon's hijack throws.
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        h?.stop();
        h = null;
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    // THE run-2 regression: heartbeat lands mid-changelevel (clock re-anchors
    // to the new map), rescue strands the old tail — and NO new-map ingest
    // event has arrived, so the reset basis was never promoted. The drain must
    // project off the last-event clock snapshot. Delay=90 vs fallback=60 makes
    // the wrong path (arrival+fallback) land ~30-40s EARLY and visibly apart.
    it('projects a rescued tail off the last-event clock when no ingest event promoted the basis', async () => {
        h = makeHarness({ delaySeconds: 90, initialGameTime: 95, boardLagSeconds: 10 });
        const T0 = Date.now();
        const tokens: EventToken[] = [];

        await runTimeline([
            [0, () => { tokens.push(h!.post('player_spawn')); }],       // tick 95 — lazy_init
            [2, () => { tokens.push(h!.post('kill')); }],               // tick 97 — snapshots clock A
            [4, () => { tokens.push(h!.post('player_stats_summary', { reason: 'half_end' })); }], // tick 99
            [5, () => { tokens.push(h!.post('half_end')); }],           // tick 100
            [6, () => h!.changelevel()],
            // Mid-gap sample: clock re-anchors to the new map, rescue fires.
            [9, async () => { await h!.sync.sample(SERVER, 'mid-gap-heartbeat'); }],
            // First new-map ingest event arrives long AFTER the rescue.
            [30, () => { tokens.push(h!.post('ktp_match_start', { half: 2 })); }],
        ], 140);

        const [spawn, kill, board, halfEnd] = tokens;
        // Projection off clock A (sampledAt≈T0, activeTime 95, delay 90):
        // releaseAt = T0 + (tick − 95 + 90)s (+10s board lag for board events).
        expectWithin(firedAt(h, spawn),   T0 + 90_000, 400, 2000);
        expectWithin(firedAt(h, kill),    T0 + 92_000, 400, 2000);
        expectWithin(firedAt(h, board),   T0 + 104_000, 400, 2000);  // 94 + 10 lag
        expectWithin(firedAt(h, halfEnd), T0 + 105_000, 400, 2000);  // 95 + 10 lag
        // Explicit discriminator: the old buggy path (arrival + 60s fallback)
        // would have fired the board at ≈T0+64s — long before the projection.
        expect(firedAt(h, board)).toBeGreaterThan(T0 + 100_000);
    });

    it('does not rescue on a coasted sample (frozen activeTime would mis-strand), and the coasted clock stays release-accurate', async () => {
        h = makeHarness({ delaySeconds: 60, initialGameTime: 95 });
        const T0 = Date.now();
        const tokens: EventToken[] = [];

        await runTimeline([
            [0, () => { tokens.push(h!.post('player_spawn')); }],  // tick 95
            [2, () => { tokens.push(h!.post('kill')); }],          // tick 97
            [4, () => { tokens.push(h!.post('kill')); }],          // tick 99
            [6, () => { h!.proxy.failing = true; }],
            [8, async () => {
                await h!.sync.sample(SERVER, 'heartbeat');         // fails → coasts
                await flushMicrotasks();
                // Coasted clock emitted — rescue must have skipped it.
                expect((h!.buffer as any).draining.size).toBe(0);
                expect(h!.buffer.queueDepth(SERVER)).toBe(3);
                expect(h!.fired).toHaveLength(0);
            }],
            [12, () => { h!.proxy.failing = false; }],
        ], 80);

        // Releases ride the coasted-then-healed clock at the true broadcast
        // instants: T0 + (tick − 95 + 60)s.
        expectWithin(firedAt(h, tokens[0]), T0 + 60_000, 400, 2000);
        expectWithin(firedAt(h, tokens[1]), T0 + 62_000, 400, 2000);
        expectWithin(firedAt(h, tokens[2]), T0 + 64_000, 400, 2000);
    });

    it('does not rescue (or crash) on a failed first sample; events release via the fallback delay', async () => {
        h = makeHarness({ delaySeconds: 60, fallbackSeconds: 60, initialGameTime: 95 });
        h.proxy.failing = true;
        const T0 = Date.now();
        let kill: EventToken | null = null;

        await runTimeline([
            [0, () => { kill = h!.post('kill'); }],  // lazy_init sample fails → offline placeholder clock
            [5, () => {
                expect((h!.buffer as any).draining.size).toBe(0);
                expect(h!.buffer.queueDepth(SERVER)).toBe(1);
            }],
        ], 75);

        // No clock ever → arrival + fallback_delay_seconds.
        expectWithin(firedAt(h, kill!), T0 + 60_000, 400, 2000);
    });

    it('a fresh mid-half sample does not strand current-level events (the +30s margin)', async () => {
        h = makeHarness({ delaySeconds: 60, initialGameTime: 95 });
        const T0 = Date.now();
        const tokens: EventToken[] = [];

        await runTimeline([
            [0, () => { tokens.push(h!.post('player_spawn')); }],
            [2, () => { tokens.push(h!.post('kill')); }],
            [4, () => { tokens.push(h!.post('kill')); }],
            [5, async () => {
                await h!.sync.sample(SERVER, 'manual');            // fresh sample → rescue runs
                await flushMicrotasks();
                expect((h!.buffer as any).draining.size).toBe(0);  // nothing mis-stranded
                expect(h!.buffer.queueDepth(SERVER)).toBe(3);
            }],
        ], 80);

        expectWithin(firedAt(h, tokens[0]), T0 + 60_000, 400, 2000);
        expectWithin(firedAt(h, tokens[1]), T0 + 62_000, 400, 2000);
        expectWithin(firedAt(h, tokens[2]), T0 + 64_000, 400, 2000);
    });

    it('unwire disconnects the rescue: a mid-gap sample no longer drains the tail', async () => {
        h = makeHarness({ delaySeconds: 90, initialGameTime: 95 });

        await runTimeline([
            [0, () => { h!.post('player_spawn'); }],
            [2, () => { h!.post('kill'); }],
            [4, () => h!.unwire()],
            [6, () => h!.changelevel()],
            [9, async () => { await h!.sync.sample(SERVER, 'mid-gap-heartbeat'); }],
        ], 12);
        await advance(20);

        // Without the wiring, the mid-gap sample strands nothing — the tail
        // just sits in the main queue (nothing fired: delay 90 not reached,
        // and no rescue ran).
        expect((h.buffer as any).draining.size).toBe(0);
        expect(h.buffer.queueDepth(SERVER)).toBe(2);
        expect(h.fired).toHaveLength(0);
    });
});
