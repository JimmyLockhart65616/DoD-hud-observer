/**
 * Territorial scoring-tick estimator — the executable specification.
 *
 * DoD's `dod_control_point_master` awards periodic territorial points to each
 * team for holding control points. The game client never shows this: not the
 * countdown, not the amount. This module reconstructs both from the persisted
 * `team_score` event stream, and `KTPHudObserver.sma` implements the SAME state
 * machine live (same constant names, same order) so the two can be diffed by eye.
 *
 * Why this file exists at all: the Pawn side is otherwise untestable. There is
 * no `player_state` in any recorded fixture (it is socket-only, never written to
 * events.jsonl), so event-stream invariants cannot cover the feature. This runs
 * over the `team_score` stream — which IS persisted — and pins the algorithm
 * against real production data instead.
 *
 * ── The mechanic, as measured on match-1777342963-NY1 (dod_thunder2) ──────────
 *
 *  - Period is exactly 30.50s. Almost certainly m_iGivePointsDelay=30 plus the
 *    master's 0.5s think. A 30s cvar would drift 0.5s/tick — never use a cvar.
 *  - Ticks land on an exact 0.5s gametime grid; cap awards nearly all do not.
 *    That is the primary discriminator.
 *  - Each half runs ONE continuous phase grid, anchored on the go-live restart
 *    (both halves back-extrapolate to half_start + ~9.6s = mp_clan_timer).
 *  - The grid RE-PHASES on a round restart (h1's grid breaks at the 1109.50
 *    capout; every later tick sits at a constant .57 offset — a new phase).
 *  - award[team] = W * count(CPs held by team whose default_owner != team).
 *    A team scores nothing for its own home points; a neutral-default point
 *    counts for whoever holds it. W = 2 on this map. No per-flag constant fits
 *    (solving the linear system contradicts), so the rule genuinely depends on
 *    holder-vs-default — which is why `defaultOwners` is a required input for
 *    the award half and why W is learned online rather than read from pdata.
 *    (CP_pointvalue is unusable: the Linux pd_dcp branch is one int short and it
 *    actually reads m_iIndex — see docs/dodx-cp-index-space-findings.md.)
 *  - A 0/0 tick is COMPLETELY INVISIBLE: no TeamScore message is sent at all.
 *    That is normal and opens every half for ~3 slots, so the estimator must
 *    roll its anchor through silence rather than drop the lock.
 *
 * Non-tick score changes that must be rejected: captures (irregular, typically
 * +1), the capout bonus (+40), and the half-2 score seeding (+118 — the engine
 * is handed the half-1 totals by KTPMatchHandler).
 */

export type StreamEvent = Record<string, any>;

export type Side = 'allies' | 'axis';
export type Owner = Side | 'neutral';

/**
 * Constants are mirrored verbatim in KTPHudObserver.sma. Keep the names and the
 * values identical in both places — the two implementations are meant to be
 * diffable line by line.
 */
export const TICK_GRID_QUANTUM = 0.5;    // CControlPointMaster think granularity
export const TICK_GRID_TOL = 0.06;       // covers a 16 fps frame (0.02 is also clean here)
export const TICK_PERIOD_MIN = 20.0;     // plausible m_iGivePointsDelay band
export const TICK_PERIOD_MAX = 45.0;
export const TICK_PHASE_TOL = 0.25;
export const TICK_CAP_PROXIMITY = 0.30;
export const TICK_CAPOUT_FLOOR = 20;     // any single-team delta >= this is a bonus/seed, not a tick
export const TICK_OVERRUN_GRACE = 0.75;
export const TICK_MISS_STRIKES = 2;      // silent slots with a NONZERO projection before unlocking
export const TICK_MAX_BLIND_ROLL = 8;
export const TICK_W_STREAK_REQ = 3;
export const TICK_W_MAX = 8;

/** Window after a restart cascade marker in which score deltas are restart noise. */
export const TICK_RESET_WINDOW = 3.0;

export type RejectReason =
    | 'negative'        // score went down — half/warmup reset
    | 'zero'            // no delta
    | 'capout'          // >= TICK_CAPOUT_FLOOR: round-win bonus or half-2 seeding
    | 'reset-window'    // inside a round-restart cascade
    | 'off-grid'        // not on the 0.5s gametime grid
    | 'cap-dirty'       // coincident with a capture, and we are not locked yet
    | 'off-phase'       // locked, plausible, but not on the phase — i.e. a capture
    | 'bootstrap';      // consumed as a lock candidate

export interface ConfirmedTick {
    half: number;
    /** Gametime of the tick (seconds since map load). */
    gt: number;
    allies: number;
    axis: number;
    /** Non-default-held counts snapshotted when the frame opened. */
    heldAllies: number;
    heldAxis: number;
    /** Period in force when this tick was confirmed. */
    period: number;
    /** Coincident with a capture: confirms phase, but never feeds W. */
    capDirty: boolean;
    /** Slots skipped since the previous confirmation (1 = adjacent). */
    slots: number;
}

export interface RejectedFrame {
    half: number;
    gt: number;
    allies: number;
    axis: number;
    reason: RejectReason;
}

export interface LockEvent {
    half: number;
    /** Gametime at which the lock was established (the confirming frame). */
    gt: number;
    period: number;
}

export interface ModelMismatch {
    half: number;
    gt: number;
    allies: number;
    axis: number;
    heldAllies: number;
    heldAxis: number;
    detail: string;
}

export interface ScoreTickResult {
    ticks: ConfirmedTick[];
    rejected: RejectedFrame[];
    locks: LockEvent[];
    /** Learned per-flag weight, or null when unknown/disputed. */
    w: number | null;
    /** True once the model was violated — W is latched off for the rest of the map. */
    wFailed: boolean;
    /** Consecutive agreeing ticks behind the current W. */
    wStreak: number;
    mismatches: ModelMismatch[];
    /** True when the grid self-check disabled the grid gate. */
    gridDisabled: boolean;
}

export interface ScoreTickOptions {
    /**
     * flag_id -> default owner. REQUIRED for the award half of the feature: the
     * award rule depends on holder-vs-default, so W cannot be learned without
     * it. Tick detection (grid + phase) works fine without it.
     *
     * The live plugin reads this from dodx's CP_default_owner. Recorded streams
     * predating that fix do not carry it, so offline callers must supply it.
     */
    defaultOwners?: Record<number, Owner>;
}

/** One frame of TeamScore messages, aggregated. */
interface Frame {
    half: number;
    gt: number;
    allies: number;
    axis: number;
    /** Non-default-held counts as of frame OPEN, before a later cap can move them. */
    heldAllies: number;
    heldAxis: number;
    capDirty: boolean;
}

function isOnGrid(gt: number): boolean {
    const q = gt / TICK_GRID_QUANTUM;
    return Math.abs(q - Math.round(q)) * TICK_GRID_QUANTUM <= TICK_GRID_TOL;
}

/**
 * Score-increase frames, aggregated per (half, gametime).
 *
 * `team_score` fires once per TeamScore MESSAGE, not once per score change —
 * 1444 records for 71 real ticks in the fixture, with one frame producing 25.
 * Frames must therefore be collapsed, taking the MAX per team: two POSTs from a
 * single frame can be recorded out of order (post_event races), which makes
 * last-write-wins read the score going backwards. That is a recording artifact,
 * not an engine one — the plugin's own reads are synchronous and monotonic.
 */
interface TimelineEntry {
    gt: number;
    half: number;
    kind: 'cap' | 'frame';
    /**
     * Non-default-held counts in force immediately BEFORE this entry — i.e.
     * throughout the interval that just ended. Ownership only changes at caps,
     * so this is what a 4 Hz poll would have seen at any instant in that
     * interval, which is what the live plugin's roll-forward reads.
     */
    heldAllies: number;
    heldAxis: number;
    frame?: Frame;
}

function buildFrames(events: ReadonlyArray<StreamEvent>, opts: ScoreTickOptions): {
    frames: Frame[];
    events: TimelineEntry[];
} {
    const defaults = opts.defaultOwners;
    const owner = new Map<number, Owner>();

    let half = 0;
    let lastCapGt = -1e9;
    let pendingKey = '';
    let pendingHi: [number, number] = [-1, -1];
    let pendingFrame: Frame | null = null;

    const frames: Frame[] = [];
    const timeline: TimelineEntry[] = [];

    const nonDefaultHeld = (side: Side): number => {
        if (!defaults) return 0;
        let n = 0;
        for (const [id, own] of owner) {
            if (own === side && defaults[id] !== undefined && defaults[id] !== side) n++;
        }
        return n;
    };

    const closePending = () => {
        if (!pendingFrame) return;
        pendingFrame.allies = pendingHi[0];
        pendingFrame.axis = pendingHi[1];
        frames.push(pendingFrame);
        timeline.push({
            gt: pendingFrame.gt, half: pendingFrame.half, kind: 'frame',
            heldAllies: pendingFrame.heldAllies, heldAxis: pendingFrame.heldAxis,
            frame: pendingFrame,
        });
        pendingFrame = null;
        pendingKey = '';
        pendingHi = [-1, -1];
    };

    for (const e of events) {
        const eHalf = typeof e.half === 'number' ? e.half : 0;
        const gt = typeof e.tick === 'number' ? e.tick : NaN;

        if (eHalf !== half) {
            closePending();
            half = eHalf;
            owner.clear();
            lastCapGt = -1e9;
        }

        if (e.event === 'flags_init' && Array.isArray(e.flags)) {
            for (const f of e.flags) {
                if (typeof f.flag_id === 'number' && typeof f.owner === 'string') {
                    owner.set(f.flag_id, f.owner as Owner);
                }
            }
            continue;
        }

        if (e.event === 'flag_captured') {
            if (Number.isFinite(gt)) {
                closePending();
                lastCapGt = gt;
                // Counts BEFORE the capture is applied: they are what was true
                // for the whole interval leading up to this instant, which is
                // the window a silent slot could have fallen in.
                timeline.push({
                    gt, half, kind: 'cap',
                    heldAllies: nonDefaultHeld('allies'),
                    heldAxis: nonDefaultHeld('axis'),
                });
            }
            if (typeof e.flag_id === 'number' && typeof e.new_owner === 'string') {
                owner.set(e.flag_id, e.new_owner as Owner);
            }
            continue;
        }

        if (e.event !== 'team_score') continue;
        if (!Number.isFinite(gt)) continue;

        const a = typeof e.allies_score === 'number' ? e.allies_score : null;
        const x = typeof e.axis_score === 'number' ? e.axis_score : null;
        if (a === null || x === null) continue;

        const key = `${half}@${gt.toFixed(3)}`;
        if (key !== pendingKey) {
            closePending();
            pendingKey = key;
            pendingHi = [a, x];
            pendingFrame = {
                half,
                gt,
                allies: a,
                axis: x,
                // Snapshot the counts at frame OPEN: a capture landing later in
                // the same instant must not retroactively change what the master
                // was looking at when it awarded.
                heldAllies: nonDefaultHeld('allies'),
                heldAxis: nonDefaultHeld('axis'),
                capDirty: gt - lastCapGt <= TICK_CAP_PROXIMITY,
            };
        } else {
            pendingHi = [Math.max(pendingHi[0], a), Math.max(pendingHi[1], x)];
        }
    }
    closePending();

    timeline.sort((p, q) => (p.half - q.half) || (p.gt - q.gt) || (p.kind === 'cap' ? -1 : 1));
    return { frames, events: timeline };
}

/**
 * Run the estimator over an event stream.
 *
 * Mirrors the plugin exactly, with one structural difference forced by working
 * offline: the plugin rolls its anchor forward on the existing 4 Hz poll, while
 * here `roll()` is driven off the event timeline. Both converge, because caps
 * are the only thing that changes the projection between slots.
 */
export function analyzeScoreTicks(
    events: ReadonlyArray<StreamEvent>,
    opts: ScoreTickOptions = {},
): ScoreTickResult {
    const { events: timeline } = buildFrames(events, opts);

    const ticks: ConfirmedTick[] = [];
    const rejected: RejectedFrame[] = [];
    const locks: LockEvent[] = [];
    const mismatches: ModelMismatch[] = [];

    // Per-map model state — survives a mid-half restart (W is a map property).
    let w: number | null = null;
    let wStreak = 0;
    let wFailed = false;

    // Grid self-check.
    let gridSeen = 0;
    let gridMiss = 0;
    let gridOk = true;
    let gridDisabled = false;

    // Phase state.
    let half = -1;
    let lastGt = -1e9;
    let anchor = 0;
    let cand: Frame | null = null;
    let period = 0;
    let locked = false;
    let strikes = 0;
    let blindRolls = 0;
    let lastResetGt = -1e9;
    let prevA = -1;
    let prevX = -1;
    let seeded = false;

    const resetPhase = () => {
        anchor = 0; cand = null; period = 0; locked = false;
        strikes = 0; blindRolls = 0;
    };
    const resetAll = () => {
        resetPhase();
        w = null; wStreak = 0; wFailed = false;
        gridSeen = 0; gridMiss = 0; gridOk = true;
        prevA = -1; prevX = -1; seeded = false;
    };

    /** Advance the anchor through slots that produced no visible award. */
    const roll = (gt: number, heldA: number, heldX: number) => {
        while (locked && period > 0 && gt > anchor + period + TICK_OVERRUN_GRACE) {
            // A silent slot is only EVIDENCE OF A WRONG PHASE when the model
            // said something should have been awarded. With both counts zero the
            // award was 0/0, which emits no TeamScore at all — exactly what we
            // just saw. Uses live counts only, so it works before W is known.
            if (heldA + heldX !== 0) {
                if (++strikes >= TICK_MISS_STRIKES) { resetPhase(); return; }
            } else {
                strikes = 0;
            }
            if (++blindRolls > TICK_MAX_BLIND_ROLL) { resetPhase(); return; }
            anchor += period;
        }
    };

    const learn = (f: Frame, dA: number, dX: number) => {
        if (!opts.defaultOwners || wFailed) return;
        const cA = f.heldAllies;
        const cX = f.heldAxis;
        const fail = (detail: string) => {
            wFailed = true; w = null; wStreak = 0;
            mismatches.push({
                half: f.half, gt: f.gt, allies: dA, axis: dX,
                heldAllies: cA, heldAxis: cX, detail,
            });
        };

        if (cA === 0 && dA !== 0) return fail('allies scored while holding no non-default point');
        if (cX === 0 && dX !== 0) return fail('axis scored while holding no non-default point');

        const wA = cA > 0 && dA % cA === 0 ? dA / cA : 0;
        const wX = cX > 0 && dX % cX === 0 ? dX / cX : 0;
        if (cA > 0 && wA === 0) return fail(`allies delta ${dA} not divisible by ${cA}`);
        if (cX > 0 && wX === 0) return fail(`axis delta ${dX} not divisible by ${cX}`);
        if (wA && wX && wA !== wX) return fail(`per-team weights disagree (${wA} vs ${wX})`);

        const cw = wA || wX;
        if (!cw) return;                                  // 0/0 slot — nothing to learn
        if (cw < 1 || cw > TICK_W_MAX) return fail(`implausible weight ${cw}`);
        if (w !== null && cw !== w) return fail(`weight changed ${w} -> ${cw}`);

        w = cw;
        wStreak++;
    };

    for (const ev of timeline) {
        if (ev.half !== half || ev.gt < lastGt - 1.0) {
            // New half, or gametime went backwards: a changelevel. Everything —
            // including the model — belongs to the map we just left.
            half = ev.half;
            resetAll();
        }
        lastGt = ev.gt;

        // Roll at EVERY entry, not just score frames. The live plugin evaluates
        // this on its 4 Hz poll, so it judges a silent slot against the counts
        // in force AT that slot. Ownership only moves at captures, so stepping
        // the roll at captures too reproduces that: without it, a slot that was
        // silent because the mid flag was neutral gets judged against the
        // ownership of whoever retook it later, and the lock drops wrongly.
        roll(ev.gt, ev.heldAllies, ev.heldAxis);

        // Captures otherwise reach the state machine only through `capDirty` on
        // the frame they contaminate; the restart window is opened by the capout
        // branch below, the score signature a round restart always carries.
        if (ev.kind === 'cap') continue;

        const f = ev.frame!;

        if (!seeded) { prevA = f.allies; prevX = f.axis; seeded = true; continue; }

        const dA = f.allies - prevA;
        const dX = f.axis - prevX;
        prevA = f.allies;
        prevX = f.axis;

        const reject = (reason: RejectReason) =>
            rejected.push({ half: f.half, gt: f.gt, allies: dA, axis: dX, reason });

        if (dA < 0 || dX < 0) { resetAll(); reject('negative'); continue; }
        if (dA === 0 && dX === 0) { reject('zero'); continue; }
        if (Math.max(dA, dX) >= TICK_CAPOUT_FLOOR) {
            // Round-win bonus or the half-2 score seeding. Both re-phase the
            // grid; neither is a tick. W is a map property and survives.
            resetPhase(); lastResetGt = f.gt; reject('capout'); continue;
        }
        if (f.gt - lastResetGt < TICK_RESET_WINDOW) { reject('reset-window'); continue; }

        // Grid self-check: if a server's frame timing never lands on the 0.5s
        // grid, the gate would silently hide the panel forever. Detect and fall
        // back rather than fail closed.
        if (gridOk && gridSeen < 12) {
            gridSeen++;
            if (!isOnGrid(f.gt)) gridMiss++;
            if (gridSeen === 12 && gridMiss === 12) { gridOk = false; gridDisabled = true; }
        }
        if (gridOk && !isOnGrid(f.gt)) { reject('off-grid'); continue; }

        if (locked && period > 0) {
            const k = Math.round((f.gt - anchor) / period);
            const err = Math.abs(f.gt - (anchor + k * period));
            if (k >= 1 && err <= TICK_PHASE_TOL) {
                ticks.push({
                    half: f.half, gt: f.gt, allies: dA, axis: dX,
                    heldAllies: f.heldAllies, heldAxis: f.heldAxis,
                    period, capDirty: f.capDirty, slots: k,
                });
                // Re-measure only from ADJACENT confirmations: a gap across
                // silent slots divides out the very jitter we are measuring.
                if (k === 1) period = f.gt - anchor;
                anchor = f.gt;
                strikes = 0;
                blindRolls = 0;
                // A cap-dirty frame still confirms PHASE, but its delta is
                // contaminated by the capture award, so it never feeds W and
                // never counts as a model violation.
                if (!f.capDirty) learn(f, dA, dX);
            } else {
                reject('off-phase');
            }
            continue;
        }

        // Bootstrap. A capture-contaminated frame is a bad seed: its delta and
        // its timing are both wrong.
        if (f.capDirty) { reject('cap-dirty'); continue; }

        if (cand) {
            const gap = f.gt - cand.gt;
            if (gap >= TICK_PERIOD_MIN && gap <= TICK_PERIOD_MAX) {
                locked = true;
                period = gap;
                anchor = f.gt;
                strikes = 0;
                blindRolls = 0;
                locks.push({ half: f.half, gt: f.gt, period });
                // Both the candidate and the confirmation are real ticks — the
                // candidate's counts were snapshotted at its own frame open.
                ticks.push({
                    half: cand.half, gt: cand.gt,
                    allies: cand.allies, axis: cand.axis,
                    heldAllies: cand.heldAllies, heldAxis: cand.heldAxis,
                    period, capDirty: false, slots: 0,
                });
                learn(cand, cand.allies, cand.axis);
                ticks.push({
                    half: f.half, gt: f.gt, allies: dA, axis: dX,
                    heldAllies: f.heldAllies, heldAxis: f.heldAxis,
                    period, capDirty: false, slots: 1,
                });
                learn(f, dA, dX);
                cand = null;
                continue;
            }
            reject('bootstrap');
        }
        // Carry the deltas on the candidate so it can feed W when it locks.
        cand = { ...f, allies: dA, axis: dX };
    }

    return {
        ticks, rejected, locks,
        w: wFailed ? null : w,
        wFailed, wStreak, mismatches, gridDisabled,
    };
}

/** Award the model projects for `side` right now; null when W is unknown. */
export function projectAward(w: number | null, nonDefaultHeld: number): number | null {
    if (w === null || w <= 0) return null;
    return w * nonDefaultHeld;
}
