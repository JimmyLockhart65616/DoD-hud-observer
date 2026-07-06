/**
 * Boundary scenario matrix for the HLTV sync/buffer subsystem.
 *
 * Each scenario drives the REAL sync service + delay buffer + rescue wiring
 * (network stubbed at fetchStatus — see hltvHarness.ts) through a compressed
 * half-1 → changelevel → half-2 timeline on jest fake timers, varying the
 * things that are actually racy in production:
 *
 *   - when the heartbeat lands relative to the changelevel gap
 *   - how late each POST arrives (curl stalls up to 120s)
 *   - RCON failures at and around the boundary (coast path)
 *   - back-to-back resets (half-2 → OT)
 *
 * Every scenario is judged by the same release-stream invariants
 * (checkInvariants): nothing lost, never early, bounded lateness, epoch
 * ordering, tick ordering. The invariants — not per-case expectations — are
 * the regression net: the 2-minute-late halftime board, the stuck-forever
 * strand, and the boundary instant-flush all violate one of them under at
 * least one scenario here.
 *
 * Compressed model with PROD-SCALE ticks: half-1 map instance is 1100s old at
 * T0 (a real half's tail magnitude — the straggler classifier's tick window
 * only behaves like production when old-tail ticks dwarf new-map ticks);
 * half-1 tail events at t=0..6 (ticks 1100..1106), changelevel at t=8, half-2
 * events from t≈18 (ticks ~10+). HLTV Delay 60 or 90 (fallback stays 60 so a
 * wrong code path lands at a visibly different instant); board lag 10;
 * heartbeat 20s.
 */
import {
    makeHarness, runTimeline, checkInvariants, SERVER, Harness, EventToken,
} from './helpers/hltvHarness';

describe('HLTV sync/buffer — boundary scenario matrix (release-stream invariants)', () => {
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

    // Standard half-1 tail: spawn/kills then the halftime board pair.
    function half1(hh: Harness): Array<[number, () => void]> {
        return [
            [0, () => { hh.post('player_spawn'); }],
            [2, () => { hh.post('kill'); }],
            [4, () => { hh.post('kill'); }],
            [6, () => {
                hh.post('player_stats_summary', { reason: 'half_end' });
                hh.post('half_end');
            }],
        ];
    }

    it('clean boundary, delay 60 (enqueue-time drain path)', async () => {
        h = makeHarness({ delaySeconds: 60, initialGameTime: 1100 });
        await runTimeline([
            ...half1(h),
            [8, () => h!.changelevel()],
            [18, () => { h!.post('ktp_match_start', { half: 2 }); }],
            [20, () => { h!.post('kill'); }],
            [25, () => { h!.post('kill'); }],
        ], 140);
        checkInvariants(h);
    });

    it('clean boundary, delay 90 (release tracks the dynamic delay, no static 60 anywhere)', async () => {
        h = makeHarness({ delaySeconds: 90, initialGameTime: 1100 });
        await runTimeline([
            ...half1(h),
            [8, () => h!.changelevel()],
            [18, () => { h!.post('ktp_match_start', { half: 2 }); }],
            [20, () => { h!.post('kill'); }],
            [25, () => { h!.post('kill'); }],
        ], 200);
        checkInvariants(h);
    });

    // Curl-stalled board, arrival still before its broadcast instant. With
    // delay 90 > fallback 60, the legacy arrival-anchored release would fire
    // it ~15s EARLY (arrival+60 < creation+90) — the never-early invariant is
    // the discriminator here.
    it('board POST stalled 15s across the boundary (delay 90) — still lands on projection', async () => {
        h = makeHarness({ delaySeconds: 90, initialGameTime: 1100 });
        let board: EventToken | null = null;
        await runTimeline([
            [0, () => { h!.post('player_spawn'); }],
            [2, () => { h!.post('kill'); }],
            [6, () => { board = h!.capture('player_stats_summary', { reason: 'half_end' }); }],
            [8, () => h!.changelevel()],
            [18, () => { h!.post('ktp_match_start', { half: 2 }); }],
            [21, () => h!.deliver(board!)],   // 15s after creation, after h2 began
            [25, () => { h!.post('kill'); }],
        ], 200);
        checkInvariants(h);
        // Bias check: the drained board must carry its deliberate late-bias.
        const f = h.fired.find(x => x.id === board!.id)!;
        const trueBroadcast = board!.mapStartWall + (board!.tick + board!.delaySeconds) * 1000;
        expect(f.firedAt).toBeGreaterThanOrEqual(trueBroadcast + h.boardLagMs - 400);
    });

    // Very late straggler board: arrives AFTER its broadcast instant passed.
    // Must fire promptly on arrival (routed straight to the drain with the
    // old-epoch basis), not sit until half-2's clock reaches its old tick.
    it('board POST stalled 120s (delay 60) — fires promptly on arrival, not at end of half 2', async () => {
        h = makeHarness({ delaySeconds: 60, initialGameTime: 1100 });
        let board: EventToken | null = null;
        await runTimeline([
            ...half1(h),
            [6.5, () => { board = h!.capture('player_stats_summary', { reason: 'half_end' }); }],
            [8, () => h!.changelevel()],
            [18, () => { h!.post('ktp_match_start', { half: 2 }); }],
            [20, () => { h!.post('kill'); }],
            [126, () => h!.deliver(board!)],
            [130, () => { h!.post('kill'); }],
        ], 240);
        checkInvariants(h);
        // The straggler board fired promptly at arrival (its broadcast instant
        // T0+66 had long passed), not at half-2's clock reaching tick ~1106.
        const f = h.fired.find(x => x.id === board!.id)!;
        expect(f.firedAt).toBeLessThanOrEqual(board!.createdAtWall + 121_500 + 4000);
    });

    // The run-2 rig regression as a matrix scenario: heartbeat re-anchors the
    // clock mid-gap, rescue drains the tail before any ingest event promoted
    // the basis. Delay 90 ≠ fallback 60 discriminates.
    it('sample lands mid-changelevel before any half-2 event (delay 90)', async () => {
        h = makeHarness({ delaySeconds: 90, initialGameTime: 1100 });
        await runTimeline([
            ...half1(h),
            [8, () => h!.changelevel()],
            [12, async () => { await h!.sync.sample(SERVER, 'mid-gap'); }],
            [18, () => { h!.post('ktp_match_start', { half: 2 }); }],
            [22, () => { h!.post('kill'); }],
        ], 200);
        checkInvariants(h);
    });

    it('RCON fails across the boundary (coast attempt in the gap, resample at half-2 start)', async () => {
        h = makeHarness({ delaySeconds: 60, initialGameTime: 1100 });
        await runTimeline([
            ...half1(h),
            [7, () => { h!.proxy.failing = true; }],
            [8, () => h!.changelevel()],
            [12, async () => { await h!.sync.sample(SERVER, 'gap-heartbeat'); }], // fails → coasts → no rescue
            [17, () => { h!.proxy.failing = false; }],
            [18, () => { h!.post('ktp_match_start', { half: 2 }); }],
            [20, () => { h!.post('kill'); }],
        ], 150);
        checkInvariants(h);
    });

    it('coast during half-1 (transient RCON outage), boundary after healing', async () => {
        h = makeHarness({ delaySeconds: 60, initialGameTime: 1100 });
        await runTimeline([
            [0, () => { h!.post('player_spawn'); }],
            [2, () => { h!.post('kill'); }],
            [3, () => { h!.proxy.failing = true; }],
            [5, async () => { await h!.sync.sample(SERVER, 'heartbeat'); }],  // coast
            [6, () => { h!.post('player_stats_summary', { reason: 'half_end' }); }],
            [10, () => { h!.proxy.failing = false; }],
            [22, () => h!.changelevel()],
            [32, () => { h!.post('ktp_match_start', { half: 2 }); }],
            [35, () => { h!.post('kill'); }],
        ], 160);
        checkInvariants(h);
    });

    // Half-2 must run long enough for its tail ticks to exceed OT's opening
    // ticks by >30s, or the OT reset is legitimately undetectable — real
    // halves always satisfy this.
    it('back-to-back resets: half-2 → OT stacks two drains FIFO', async () => {
        h = makeHarness({ delaySeconds: 60, initialGameTime: 1100 });
        await runTimeline([
            ...half1(h),
            [8, () => h!.changelevel()],
            [18, () => { h!.post('ktp_match_start', { half: 2 }); }],
            [30, () => { h!.post('kill'); }],
            [60, () => {
                h!.post('player_stats_summary', { reason: 'half_end' });   // h2-end board (tick ~52)
                h!.post('half_end');
            }],
            [62, () => h!.changelevel()],                                  // OT changelevel
            [72, () => { h!.post('ktp_match_start', { half: 101 }); }],
            [76, () => { h!.post('kill'); }],
        ], 190);
        checkInvariants(h);
    });

    // Non-board straggler: an old-half kill arriving while half-2 events are
    // already flowing. Must be routed to the old-epoch drain (fires at its
    // true broadcast instant) and must NOT poison the queue tail — the fresh
    // kill right after it would otherwise trip a wholesale queue drain.
    it('old-half kill arrives mid-half-2 between fresh events', async () => {
        h = makeHarness({ delaySeconds: 60, initialGameTime: 1100 });
        let straggler: EventToken | null = null;
        await runTimeline([
            ...half1(h),
            [5, () => { straggler = h!.capture('kill'); }],   // tick 100, epoch 0
            [8, () => h!.changelevel()],
            [18, () => { h!.post('ktp_match_start', { half: 2 }); }],
            [20, () => { h!.post('kill'); }],
            [24, () => h!.deliver(straggler!)],               // arrives between fresh kills
            [26, () => { h!.post('kill'); }],
            [30, () => { h!.post('kill'); }],
        ], 150);
        checkInvariants(h);
        // It fired at its OWN epoch's broadcast instant, not the new one's.
        const f = h.fired.find(x => x.id === straggler!.id)!;
        const trueBroadcast = straggler!.mapStartWall + (straggler!.tick + straggler!.delaySeconds) * 1000;
        expect(Math.abs(f.firedAt - trueBroadcast)).toBeLessThanOrEqual(2000);
    });

    // Quiet warmup: no half-2 ingest events until well past the delay window.
    // The heartbeat is then the only boundary witness — its rescue must drain
    // the tail on the old basis, and the eventual first half-2 event (a >30s
    // forward tick jump after the long silence) must NOT be misclassified as
    // an old-epoch straggler.
    it('first half-2 event arrives only 67s after the changelevel (heartbeat-only boundary)', async () => {
        h = makeHarness({ delaySeconds: 60, initialGameTime: 1100 });
        await runTimeline([
            ...half1(h),
            [8, () => h!.changelevel()],
            // heartbeats at t=20/40/60 witness the Game-Time drop and rescue.
            [75, () => { h!.post('ktp_match_start', { half: 2 }); }],  // tick ≈67
            [80, () => { h!.post('kill'); }],
            [90, () => { h!.post('kill'); }],
        ], 210);
        checkInvariants(h);
    });
});
