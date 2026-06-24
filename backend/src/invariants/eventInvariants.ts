/**
 * Event-stream invariants — correctness properties that must hold for ANY real
 * match, checked against the plugin's emitted event stream (not the data
 * pipeline). These exist to catch a CLASS of bug without a pre-written test per
 * instance: a violation means the plugin emitted a self-inconsistent stream.
 *
 * Design rules (so they survive and don't get --no-verify'd into the grave):
 *   - Every invariant here was validated to hold on the real production fixture
 *     (backend/src/__tests__/fixtures/match-1777342963-NY1.jsonl.gz). An
 *     invariant that false-positives on real data is worse than no invariant.
 *   - Keep the set SMALL and high-signal. Robust-but-loose beats tight-but-flaky:
 *     a check that occasionally trips on real data gets disabled, taking its
 *     value with it.
 *   - Failure messages must be self-explanatory (name the half, the counts, the
 *     likely cause) so the next person FIXES the bug instead of deleting the test.
 *
 * Deliberately NOT included, because they false-positive on real plugin output:
 *   - "flag_captured.captor_ids non-empty" — captor_ids is empty in extension
 *     mode (pre-existing latent bug; the fixture proves it's always []).
 *   - per-(user) monotonic stats — reconnect/slot-reuse and the half reset
 *     legitimately drop a player's accumulators.
 *   - "every scored user_id had a prior player_connect" — the warmup race emits
 *     player_score for ~5 users before their connect in the real fixture.
 */

export type StreamEvent = Record<string, any>;

export interface InvariantViolation {
    invariant: string;
    message: string;
}

export type Invariant = (events: ReadonlyArray<StreamEvent>) => InvariantViolation[];

const TEAM_VALUES = new Set(['allies', 'axis', 'spectator', 'neutral']);
const FLAG_OWNER_VALUES = new Set(['allies', 'axis', 'neutral']);

function halfOf(e: StreamEvent): number {
    return typeof e.half === 'number' ? e.half : 0;
}

function isRealCap(e: StreamEvent): boolean {
    return e.event === 'flag_captured' && (e.new_owner === 'allies' || e.new_owner === 'axis');
}

/** True if any player_score / player_stats_summary row reports obj_score > 0. */
function hasPositiveObjScore(e: StreamEvent): boolean {
    if (e.event === 'player_score') return typeof e.obj_score === 'number' && e.obj_score > 0;
    if (e.event === 'player_stats_summary' && Array.isArray(e.players)) {
        return e.players.some((p: any) => typeof p?.obj_score === 'number' && p.obj_score > 0);
    }
    return false;
}

function hasPositiveCaps(e: StreamEvent): boolean {
    if (e.event === 'player_score') return typeof e.caps === 'number' && e.caps > 0;
    if (e.event === 'player_stats_summary' && Array.isArray(e.players)) {
        return e.players.some((p: any) => typeof p?.caps === 'number' && p.caps > 0);
    }
    return false;
}

function capsFieldEverPresent(events: ReadonlyArray<StreamEvent>): boolean {
    return events.some(e =>
        (e.event === 'player_score' && typeof e.caps === 'number') ||
        (e.event === 'player_stats_summary' && Array.isArray(e.players) &&
            e.players.some((p: any) => typeof p?.caps === 'number')));
}

/**
 * CAP-CREDIT (obj_score): in every half that has at least one real flag capture,
 * the stream must report obj_score > 0 for someone. This is the exact signature
 * of the regression fixed in 487f472 — the deferred dod_score_event left every
 * player's obj_score at 0 even as flags were captured. Robust by construction:
 * it needs no captor identity and no per-player team attribution (both unreliable
 * here), and it held on 100% of real captures (half 1: 32 caps/441 positive,
 * half 2: 34/484).
 */
export const capCreditObjScore: Invariant = (events) => {
    const caps = new Map<number, number>();
    const objPos = new Set<number>();
    for (const e of events) {
        const h = halfOf(e);
        if (isRealCap(e)) caps.set(h, (caps.get(h) ?? 0) + 1);
        if (hasPositiveObjScore(e)) objPos.add(h);
    }
    const out: InvariantViolation[] = [];
    for (const [h, n] of caps) {
        if (!objPos.has(h)) {
            out.push({
                invariant: 'cap-credit-objscore',
                message: `half ${h}: ${n} flag_captured(allies|axis) but no player_score/summary ever reported obj_score > 0 — flag captures are not crediting objective score (the dod_score_event deferral class of bug, cf. 487f472).`,
            });
        }
    }
    return out;
};

/**
 * CAP-CREDIT (caps): the forward-looking twin. Guarded on the `caps` field being
 * present at all, so it is a no-op on pre-caps streams (the field shipped in
 * bc9f448) and can never false-positive on older captures. Once caps is emitted,
 * a half with real captures must show caps > 0 for someone.
 */
export const capCreditCaps: Invariant = (events) => {
    if (!capsFieldEverPresent(events)) return [];
    const caps = new Map<number, number>();
    const capsPos = new Set<number>();
    for (const e of events) {
        const h = halfOf(e);
        if (isRealCap(e)) caps.set(h, (caps.get(h) ?? 0) + 1);
        if (hasPositiveCaps(e)) capsPos.add(h);
    }
    const out: InvariantViolation[] = [];
    for (const [h, n] of caps) {
        if (!capsPos.has(h)) {
            out.push({
                invariant: 'cap-credit-caps',
                message: `half ${h}: ${n} flag_captured(allies|axis) and the plugin emits a caps field, but no player reached caps > 0 — per-player cap counters are not incrementing.`,
            });
        }
    }
    return out;
};

/**
 * ENUM SANITY: team and flag-owner fields stay inside their vocabularies. Cheap,
 * bulletproof on real data, catches gross malformation / schema drift. Reports
 * each distinct bad value once (not per event) to stay high-signal.
 */
export const enumSanity: Invariant = (events) => {
    const badTeams = new Set<string>();
    const badOwners = new Set<string>();
    for (const e of events) {
        if (typeof e.team === 'string' && !TEAM_VALUES.has(e.team)) badTeams.add(e.team);
        if (e.event === 'flag_captured' && typeof e.new_owner === 'string' && !FLAG_OWNER_VALUES.has(e.new_owner)) {
            badOwners.add(e.new_owner);
        }
    }
    const out: InvariantViolation[] = [];
    for (const t of badTeams) {
        out.push({ invariant: 'enum-team', message: `invalid team value "${t}" (expected allies|axis|spectator|neutral)` });
    }
    for (const o of badOwners) {
        out.push({ invariant: 'enum-flag-owner', message: `flag_captured with invalid new_owner "${o}" (expected allies|axis|neutral)` });
    }
    return out;
};

/** All invariants, in evaluation order. Reused by tests and (later) the audit harness. */
export const INVARIANTS: ReadonlyArray<Invariant> = [capCreditObjScore, capCreditCaps, enumSanity];

/** Run every invariant over an emitted event stream and return all violations. */
export function checkEventStream(events: ReadonlyArray<StreamEvent>): InvariantViolation[] {
    const out: InvariantViolation[] = [];
    for (const fn of INVARIANTS) out.push(...fn(events));
    return out;
}
