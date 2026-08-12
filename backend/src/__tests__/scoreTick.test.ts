/**
 * Territorial scoring-tick estimator tests.
 *
 * Two halves, deliberately:
 *
 *  1. The production fixture (dod_thunder2, 8997 events). This is the only real
 *     ground truth that exists for the mechanic, and it pins the headline
 *     numbers so a future edit that breaks the algorithm fails loudly.
 *  2. Synthetic streams for the paths the fixture never reaches. Every slot
 *     inside every locked run in that match produced a visible award, so the
 *     roll-forward-through-silence logic — the thing that stops the clock
 *     unlocking every time both teams sit on their home flags — is completely
 *     untested by it. Same for the W latch-off and the grid self-check.
 *
 * `KTPHudObserver.sma` implements this same state machine live with the same
 * constant names. If you change behaviour here, change it there too.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import {
    analyzeScoreTicks,
    Owner,
    StreamEvent,
    TICK_MISS_STRIKES,
} from '../invariants/scoreTick';

import 'jest';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'match-1777342963-NY1.jsonl.gz');

/**
 * dod_thunder2's control points, in DLL index order, with their default owners.
 * The stream itself cannot supply these: `flags_init` predates both the `reason`
 * field and dodx's BSP `point_default_owner` parse, so it carries only live
 * ownership — and at map load that reads neutral for every flag because of the
 * pd_dcp misalignment. The live plugin gets these from CP_default_owner.
 */
const THUNDER2_DEFAULTS: Record<number, Owner> = {
    0: 'allies',    // POINT_DONNER_ALLIEDHQ
    1: 'allies',    // POINT_ALLIEDSTREET
    2: 'neutral',   // POINT_DONNER_MAINSTREET — the contested mid
    3: 'axis',      // POINT_AXISSTREET
    4: 'axis',      // POINT_DONNER_AXISHQ
};

function loadFixture(): StreamEvent[] {
    const raw = zlib.gunzipSync(fs.readFileSync(FIXTURE_PATH)).toString('utf-8');
    return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

describe('scoring-tick estimator — production fixture (dod_thunder2)', () => {
    const events = loadFixture();
    const result = analyzeScoreTicks(events, { defaultOwners: THUNDER2_DEFAULTS });

    it('confirms 71 ticks, 35 in half 1 and 36 in half 2', () => {
        expect(result.ticks).toHaveLength(71);
        expect(result.ticks.filter(t => t.half === 1)).toHaveLength(35);
        expect(result.ticks.filter(t => t.half === 2)).toHaveLength(36);
    });

    it('measures a period of exactly 30.50s on every confirmation', () => {
        const periods = [...new Set(result.ticks.map(t => +t.period.toFixed(3)))];
        expect(periods).toEqual([30.5]);
    });

    it('learns W = 2 with no model violation across all 71 ticks', () => {
        expect(result.w).toBe(2);
        expect(result.wFailed).toBe(false);
        expect(result.mismatches).toEqual([]);
        expect(result.wStreak).toBeGreaterThanOrEqual(36);
    });

    it('locks three times: half 1, again after the capout, and half 2', () => {
        expect(result.locks.map(l => [l.half, l.gt])).toEqual([
            [1, 393.5],     // 2nd candidate of the half
            [1, 1204],      // re-lock after the 1109.50 capout re-phased the grid
            [2, 223.5],
        ]);
    });

    it('runs one continuous phase per lock, on a 30.5s grid', () => {
        const h1 = result.ticks.filter(t => t.half === 1).map(t => t.gt);
        const h2 = result.ticks.filter(t => t.half === 2).map(t => t.gt);
        expect(h1[0]).toBe(363);        // 271.50 + 3 silent slots; 271.50 == go-live restart
        expect(h1[h1.length - 1]).toBe(1448);
        expect(h2[0]).toBe(193);        // 101.50 + 3 silent slots
        expect(h2[h2.length - 1]).toBe(1260.5);

        // Half 2 never restarts, so it is one unbroken grid end to end.
        expect((1260.5 - 193) / 30.5).toBe(35);
        expect(h2).toHaveLength(36);
    });

    it('rejects the capout bonuses and the half-2 score seeding', () => {
        const capouts = result.rejected.filter(r => r.reason === 'capout');
        expect(capouts.map(r => [r.half, r.gt, Math.max(r.allies, r.axis)])).toEqual([
            [1, 1109.5, 40],    // round-win bonus
            [2, 103.62, 118],   // KTPMatchHandler seeding half-1 totals into gamerules
            [2, 1275.5, 40],    // round-win bonus
        ]);
    });

    it('rejects the score resets that bracket the half boundary', () => {
        const negatives = result.rejected.filter(r => r.reason === 'negative');
        expect(negatives.map(r => [r.half, r.gt])).toEqual([[1, 271.88], [2, 101.75]]);
    });

    it('rejects capture awards, on-grid and off-grid alike', () => {
        // Captures land on arbitrary fractions (off-grid); a few coincide with
        // the 0.5s grid but never with the phase.
        expect(result.rejected.filter(r => r.reason === 'off-grid').length).toBeGreaterThan(40);
        expect(result.rejected.filter(r => r.reason === 'off-phase').length).toBeGreaterThan(10);
    });

    it('never accepts a capture-contaminated frame as a tick', () => {
        expect(result.ticks.filter(t => t.capDirty)).toHaveLength(0);
    });

    it('keeps the grid gate enabled on real server timing', () => {
        expect(result.gridDisabled).toBe(false);
    });

    it('holds the award model on every confirmed tick', () => {
        // The model is a third discriminator, not just a projection: if a
        // non-tick had slipped through, its delta would not satisfy
        // delta == 2 * non-default-held for both teams simultaneously.
        for (const t of result.ticks) {
            expect(t.allies).toBe(2 * t.heldAllies);
            expect(t.axis).toBe(2 * t.heldAxis);
        }
    });
});

// ── Synthetic streams — paths the fixture never reaches ─────────────────────

/**
 * Three flags, allies holding the neutral-default mid. That gives allies
 * exactly ONE non-default point (worth 2/tick) and axis none — the ordinary
 * shape of a held map, and the configuration these streams assume throughout.
 * A team sitting only on its own home flags banks nothing at all.
 */
const FLAGS_INIT: StreamEvent = {
    event: 'flags_init', half: 1, tick: 0,
    flags: [
        { flag_id: 0, flag_name: 'A_HQ', owner: 'allies' },
        { flag_id: 1, flag_name: 'MID', owner: 'allies' },
        { flag_id: 2, flag_name: 'X_HQ', owner: 'axis' },
    ],
};
const SYNTH_DEFAULTS: Record<number, Owner> = { 0: 'allies', 1: 'neutral', 2: 'axis' };

/**
 * Build a stream of TeamScore frames (and optional caps) at given gametimes.
 *
 * NOTE: the first frame is consumed as the score BASELINE — the estimator works
 * on deltas, and there is no delta until it has seen two frames. So the first
 * listed frame never appears as a confirmed tick.
 */
function stream(
    steps: Array<{ tick: number; allies: number; axis: number } | { tick: number; cap: number; to: Owner }>,
): StreamEvent[] {
    const out: StreamEvent[] = [{ ...FLAGS_INIT }];
    for (const s of steps) {
        if ('cap' in s) {
            out.push({ event: 'flag_captured', half: 1, tick: s.tick, flag_id: s.cap, new_owner: s.to });
        } else {
            out.push({ event: 'team_score', half: 1, tick: s.tick, allies_score: s.allies, axis_score: s.axis });
        }
    }
    return out;
}

describe('scoring-tick estimator — synthetic', () => {
    it('rolls the anchor through a silent slot instead of unlocking', () => {
        // Allies hold mid (1 non-default) so they bank 2/tick. Axis hold only
        // their HQ and bank nothing — this is the ordinary case, not an edge.
        // Slot at t=120 is skipped entirely: allies lose mid at t=100 and
        // retake it at t=140, so that slot awards 0/0 and emits NOTHING.
        const ev = stream([
            { tick: 0, allies: 0, axis: 0 },        // baseline
            { tick: 30, allies: 2, axis: 0 },
            { tick: 60, allies: 4, axis: 0 },
            { tick: 90, allies: 6, axis: 0 },
            { tick: 100, cap: 1, to: 'axis' },      // axis take mid...
            { tick: 100.37, allies: 6, axis: 1 },   // ...cap award, off-grid
            { tick: 105, cap: 1, to: 'neutral' },   // mid goes neutral: nobody banks
            { tick: 140, cap: 1, to: 'allies' },    // allies retake it
            { tick: 140.22, allies: 7, axis: 1 },   // cap award, off-grid
            { tick: 150, allies: 9, axis: 1 },      // next visible tick — slot 120 was silent
            { tick: 180, allies: 11, axis: 1 },
        ]);
        const r = analyzeScoreTicks(ev, { defaultOwners: SYNTH_DEFAULTS });

        expect(r.locks).toHaveLength(1);
        expect(r.ticks.map(t => t.gt)).toEqual([30, 60, 90, 150, 180]);
        // The lock survived the silence: 150 is one rolled slot past 120.
        expect(r.ticks.find(t => t.gt === 150)!.slots).toBe(1);
        expect(r.w).toBe(2);
        expect(r.wFailed).toBe(false);
    });

    it('unlocks after TICK_MISS_STRIKES slots that should have scored', () => {
        // Allies hold mid throughout, so every slot owes them 2 — silence here
        // is real evidence the phase is wrong, unlike the test above.
        const ev = stream([
            { tick: 0, allies: 0, axis: 0 },        // baseline
            { tick: 30, allies: 2, axis: 0 },
            { tick: 60, allies: 4, axis: 0 },
            // slots at 90 and 120 owe 2 apiece and produce nothing
            { tick: 150, allies: 6, axis: 0 },
        ]);
        const r = analyzeScoreTicks(ev, { defaultOwners: SYNTH_DEFAULTS });

        expect(TICK_MISS_STRIKES).toBe(2);
        // The t=150 frame is not confirmed: the lock was dropped on the way there.
        expect(r.ticks.map(t => t.gt)).toEqual([30, 60]);
    });

    it('re-locks on a fresh phase after a capout re-phases the grid', () => {
        const ev = stream([
            { tick: 0, allies: 0, axis: 0 },         // baseline
            { tick: 30, allies: 2, axis: 0 },
            { tick: 60, allies: 4, axis: 0 },
            { tick: 71.5, allies: 44, axis: 0 },     // capout bonus — re-phases
            { tick: 88, allies: 46, axis: 0 },       // new phase, off the old grid
            { tick: 118, allies: 48, axis: 0 },
            { tick: 148, allies: 50, axis: 0 },
        ]);
        const r = analyzeScoreTicks(ev, { defaultOwners: SYNTH_DEFAULTS });

        expect(r.rejected.filter(x => x.reason === 'capout')).toHaveLength(1);
        // A lock is recorded at the CONFIRMING frame, not at the candidate.
        expect(r.locks.map(l => l.gt)).toEqual([60, 118]);
        expect(r.ticks.map(t => t.gt)).toEqual([30, 60, 88, 118, 148]);
    });

    it('latches W off for the map when the award model is violated', () => {
        // t=90 awards 3 to allies while they hold exactly one non-default point.
        // Not divisible into a weight consistent with the established W=2.
        const ev = stream([
            { tick: 0, allies: 0, axis: 0 },        // baseline
            { tick: 30, allies: 2, axis: 0 },
            { tick: 60, allies: 4, axis: 0 },
            { tick: 90, allies: 7, axis: 0 },
            { tick: 120, allies: 9, axis: 0 },
        ]);
        const r = analyzeScoreTicks(ev, { defaultOwners: SYNTH_DEFAULTS });

        expect(r.wFailed).toBe(true);
        expect(r.w).toBeNull();
        expect(r.mismatches).toHaveLength(1);
        expect(r.mismatches[0].gt).toBe(90);
        // The clock is unaffected — only the numbers go dark.
        expect(r.ticks.map(t => t.gt)).toEqual([30, 60, 90, 120]);
    });

    it('detects ticks without defaults, but learns no weight', () => {
        const ev = stream([
            { tick: 0, allies: 0, axis: 0 },        // baseline
            { tick: 30, allies: 2, axis: 0 },
            { tick: 60, allies: 4, axis: 0 },
        ]);
        const r = analyzeScoreTicks(ev);      // no defaultOwners

        expect(r.ticks.map(t => t.gt)).toEqual([30, 60]);
        expect(r.w).toBeNull();
        expect(r.wFailed).toBe(false);
    });

    it('falls back to phase-only when nothing lands on the 0.5s grid', () => {
        // A server whose frame timing never coincides with the master's think.
        // Without the self-check the grid gate would hide the panel forever.
        const off = 0.17;
        const steps = [];
        for (let i = 0; i < 14; i++) {
            steps.push({ tick: i * 30 + off, allies: i * 2, axis: 0 });
        }
        const r = analyzeScoreTicks(stream(steps), { defaultOwners: SYNTH_DEFAULTS });

        expect(r.gridDisabled).toBe(true);
        expect(r.ticks.length).toBeGreaterThan(0);
    });

    it('does not seed a lock from a capture-contaminated frame', () => {
        // The frame must be ON the 0.5s grid to reach the cap-dirty check at
        // all — an off-grid cap award is already rejected a step earlier.
        const ev = stream([
            { tick: 0, allies: 0, axis: 0 },      // baseline
            { tick: 10.4, cap: 2, to: 'allies' },
            { tick: 10.5, allies: 1, axis: 0 },   // cap award, within TICK_CAP_PROXIMITY
            { tick: 40.5, allies: 3, axis: 0 },   // exactly one period later — a trap
        ]);
        const r = analyzeScoreTicks(ev, { defaultOwners: SYNTH_DEFAULTS });

        expect(r.rejected.some(x => x.reason === 'cap-dirty')).toBe(true);
        expect(r.locks).toHaveLength(0);
    });
});
