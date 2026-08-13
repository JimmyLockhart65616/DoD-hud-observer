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
 *   - "victim_health >= 0 implies damage === damage_raw" — true by construction
 *     today, but any external heal (admin plugin, future dodx behaviour) desyncs
 *     the g_last_health baseline and makes it fire on legitimate data.
 *   - "at least one overkill hit must show damage < damage_raw" — it would catch a
 *     field-emitted-but-clamp-dead regression, but it cannot be validated against
 *     real data until a post-2.5.0 match is archived. Add it then, with the same
 *     validated-on-real-data pedigree as everything else here.
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
        // flags_init is the authoritative full-state broadcast, so a bad owner
        // here mis-colours the whole bar, not one flag.
        if (e.event === 'flags_init' && Array.isArray(e.flags)) {
            for (const f of e.flags) {
                if (typeof f?.owner === 'string' && !FLAG_OWNER_VALUES.has(f.owner)) badOwners.add(f.owner);
            }
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

/**
 * SUMMARY-ROSTER: a boundary stats summary (reason match_end / half_end) must
 * carry player rows when there was still a connected on-team roster at the moment
 * it fired. This is the exact signature of the intermission team-read bug: the
 * plugin's emit_stats_summary filtered on the LIVE get_user_team(id), which
 * returns non-ALLIES/AXIS for everyone during the end-of-match intermission, so
 * every row was silently dropped and the endgame board came out EMPTY (confirmed
 * on 1783044529-ATL1: 12 connected players, players:[]). Fixed by reading the
 * plugin-tracked g_player_team[] instead of the live engine team.
 *
 * Robust by construction: the "expected roster" is reconstructed from the
 * stream's own connect/spawn/team_change/disconnect events, so a legitimately
 * empty summary (everyone disconnected before the boundary → roster already 0)
 * is a no-op, never a false positive — it fires ONLY when players were
 * demonstrably present yet the board is empty. No-op on pre-summary streams:
 * the NY1 fixture predates the stats-summary feature (2026-06-12) and emits none,
 * so this invariant is exercised via the injected-summary corruption test in
 * productionFixture.test.ts rather than by the fixture directly.
 */
export const summaryRosterNonEmpty: Invariant = (events) => {
    const BOUNDARY_REASONS = new Set(['match_end', 'half_end']);
    const MIN_ROSTER = 2; // robust-but-loose: the bug collapses a full ~12-player board to 0
    const roster = new Map<string, string>(); // user_id -> last-seen team
    const out: InvariantViolation[] = [];
    for (const e of events) {
        const uid = typeof e.user_id === 'string' ? e.user_id : undefined;
        if (uid) {
            if (e.event === 'player_connect' || e.event === 'player_spawn' || e.event === 'player_team_change') {
                if (typeof e.team === 'string') roster.set(uid, e.team);
            } else if (e.event === 'player_disconnect') {
                roster.delete(uid);
            }
        }
        if (e.event === 'player_stats_summary' && BOUNDARY_REASONS.has(e.reason)) {
            let onTeam = 0;
            for (const t of roster.values()) if (t === 'allies' || t === 'axis') onTeam++;
            const rows = Array.isArray(e.players) ? e.players.length : 0;
            if (onTeam >= MIN_ROSTER && rows === 0) {
                out.push({
                    invariant: 'summary-roster-nonempty',
                    message: `${e.reason} summary (half ${halfOf(e)}) carried 0 player rows while ${onTeam} connected players were on a team — the endgame/halftime board is empty despite a live roster. This is the get_user_team-at-intermission bug: emit_stats_summary must read the tracked g_player_team[], not the live engine team.`,
                });
            }
        }
    }
    return out;
};

/**
 * CAP-BREAK CONSISTENCY: the kill-on-point break event and the per-player
 * cap_breaks accumulator must move together, half-scoped:
 *   (a) schema: every cap_break event carries reason "kill", a breaker_id, and
 *       broke_team allies|axis;
 *   (b) every half with a cap_break event must show cap_breaks > 0 in some
 *       player_score/summary row (the plugin emits the breaker's refreshed
 *       player_score in the same code path as the event);
 *   (c) every half where a row reports cap_breaks > 0 must contain a cap_break
 *       event (the accumulator only increments on a credited break).
 * Deliberately co-occurrence, not ordering: the event and the score ride
 * separate HTTP POSTs and may arrive reordered. No-op on pre-feature streams
 * (no cap_break events, no nonzero cap_breaks fields). Validated against the
 * 1783302239-CHI1 / 1782879518-CHI1 prod pulls (2026-07-06 forensics).
 */
export const capBreakConsistency: Invariant = (events) => {
    const out: InvariantViolation[] = [];
    const breakHalves = new Set<number>();
    const statHalves = new Set<number>();
    for (const e of events) {
        const h = halfOf(e);
        if (e.event === 'cap_break') {
            breakHalves.add(h);
            if (e.reason !== 'kill' || typeof e.breaker_id !== 'string' || !e.breaker_id ||
                (e.broke_team !== 'allies' && e.broke_team !== 'axis')) {
                out.push({
                    invariant: 'cap-break-schema',
                    message: `half ${h}: malformed cap_break (reason=${JSON.stringify(e.reason)}, breaker_id=${JSON.stringify(e.breaker_id)}, broke_team=${JSON.stringify(e.broke_team)}) — expected reason "kill", a breaker steamid, and broke_team allies|axis.`,
                });
            }
        }
        const rows: any[] = e.event === 'player_score' ? [e]
            : (e.event === 'player_stats_summary' && Array.isArray(e.players)) ? e.players : [];
        if (rows.some(p => typeof p?.cap_breaks === 'number' && p.cap_breaks > 0)) statHalves.add(h);
    }
    for (const h of breakHalves) {
        if (!statHalves.has(h)) {
            out.push({
                invariant: 'cap-break-credit',
                message: `half ${h}: cap_break event(s) emitted but no player_score/summary row ever reported cap_breaks > 0 — the break event fired without crediting the breaker's accumulator.`,
            });
        }
    }
    for (const h of statHalves) {
        if (!breakHalves.has(h)) {
            out.push({
                invariant: 'cap-break-orphan-stat',
                message: `half ${h}: a player_score/summary row reports cap_breaks > 0 but the stream contains no cap_break event that half — the accumulator moved without a credited break.`,
            });
        }
    }
    return out;
};

/**
 * FLAGS_INIT REASON SCHEMA: once the plugin tags snapshots, every snapshot must
 * carry a reason from the known vocabulary.
 *
 * This guards a silent-degradation path rather than a crash. The overlay decides
 * whether to adopt a team→neutral downgrade purely from `reason`
 * (Socket.jsx flags_init): authoritative reasons are adopted verbatim, anything
 * else keeps the conservative "never grey out a captured flag" behaviour that
 * existed before the field. So a snapshot emitted with a missing or misspelled
 * reason does not fail loudly — it just stops resetting the flag bar, which is
 * exactly the bug the field was added to fix, back again and invisible.
 *
 * No-op on streams that predate the field (they carry no reason anywhere), so it
 * cannot false-positive on the archived fixtures.
 */
const FLAGS_INIT_REASONS = new Set(['map_load', 'match_start', 'reset', 'tick']);

export const flagsInitReason: Invariant = (events) => {
    const snapshots = events.filter(e => e.event === 'flags_init');
    if (!snapshots.some(e => typeof e.reason === 'string')) return [];

    const missing = new Map<number, number>();
    const bad = new Set<string>();
    for (const e of snapshots) {
        if (typeof e.reason !== 'string') {
            const h = halfOf(e);
            missing.set(h, (missing.get(h) ?? 0) + 1);
        } else if (!FLAGS_INIT_REASONS.has(e.reason)) {
            bad.add(e.reason);
        }
    }

    const out: InvariantViolation[] = [];
    for (const [h, n] of missing) {
        out.push({
            invariant: 'flags-init-reason-missing',
            message: `half ${h}: ${n} flags_init without a reason, in a stream that tags others — the overlay falls back to the conservative path for these and will not reset flag ownership (expected one of ${[...FLAGS_INIT_REASONS].join('|')}).`,
        });
    }
    for (const r of bad) {
        out.push({
            invariant: 'flags-init-reason-enum',
            message: `flags_init with unknown reason "${r}" — the overlay treats anything it does not recognise as a non-authoritative tick and will not reset flag ownership (expected one of ${[...FLAGS_INIT_REASONS].join('|')}).`,
        });
    }
    return out;
};

/** All invariants, in evaluation order. Reused by tests and (later) the audit harness. */
/**
 * DAMAGE-APPLIED BOUND (guarded, forward-looking).
 *
 * Since plugin 2.5.0 the `damage` field is APPLIED damage — the health the victim
 * actually lost — and `damage_raw` is what dodx reported: (int)pev->dmg_take, which
 * the game DLL never clamps to remaining health. Before the clamp, the killing
 * blow's overkill was banked in full: 37% of all reported damage on the NY1 fixture
 * (95,608 raw vs ~61,000 applied), which flipped the StatsBoard MVP on 2 of 4
 * team-halves.
 *
 * The property: 0 <= damage <= damage_raw. A regression that re-emits raw into
 * `damage` breaks the upper bound; a broken clamp breaks the lower one.
 *
 * GUARDED on damage_raw being present anywhere in the stream, so this is a total
 * no-op on every pre-2.5.0 capture (including the NY1 fixture, which has no
 * damage_raw field at all) and cannot false-positive on archived data.
 */
export const damageAppliedBound: Invariant = (events) => {
    if (!events.some(e => e.event === 'damage' && typeof e.damage_raw === 'number')) return [];

    const negative = new Map<number, StreamEvent[]>();
    const exceeds = new Map<number, StreamEvent[]>();
    for (const e of events) {
        if (e.event !== 'damage') continue;
        if (typeof e.damage !== 'number' || typeof e.damage_raw !== 'number') continue;
        const bucket = e.damage < 0 ? negative : e.damage > e.damage_raw ? exceeds : null;
        if (!bucket) continue;
        const half = halfOf(e);
        if (!bucket.has(half)) bucket.set(half, []);
        bucket.get(half)!.push(e);
    }

    const sample = (rows: StreamEvent[]) => rows.slice(0, 3)
        .map(e => `${e.attacker_id}->${e.victim_id} ${e.weapon} damage=${e.damage} raw=${e.damage_raw} victim_health=${e.victim_health}`)
        .join('; ');

    const out: InvariantViolation[] = [];
    for (const [half, rows] of negative) {
        out.push({
            invariant: 'damage-applied-negative',
            message: `half ${half}: ${rows.length} damage event(s) with damage < 0 — the applied-damage clamp in client_damage underflowed. Samples: ${sample(rows)}`,
        });
    }
    for (const [half, rows] of exceeds) {
        out.push({
            invariant: 'damage-applied-exceeds-raw',
            message: `half ${half}: ${rows.length} damage event(s) with damage > damage_raw — applied damage can never exceed what dodx reported, so the clamp is crediting overkill again (g_last_health desync, likely the baseline update drifting inside the accumulate gate). Samples: ${sample(rows)}`,
        });
    }
    return out;
};

export const INVARIANTS: ReadonlyArray<Invariant> = [capCreditObjScore, capCreditCaps, enumSanity, summaryRosterNonEmpty, capBreakConsistency, flagsInitReason, damageAppliedBound];

/** Run every invariant over an emitted event stream and return all violations. */
export function checkEventStream(events: ReadonlyArray<StreamEvent>): InvariantViolation[] {
    const out: InvariantViolation[] = [];
    for (const fn of INVARIANTS) out.push(...fn(events));
    return out;
}
