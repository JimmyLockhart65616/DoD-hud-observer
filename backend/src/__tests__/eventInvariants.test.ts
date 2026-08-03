/**
 * Unit tests for the event-stream invariant library. These drive synthetic
 * clean + deliberately-corrupted streams to prove each invariant fires in the
 * bug direction and stays quiet on valid data. The companion check against the
 * REAL production fixture (no false positives) lives in productionFixture.test.ts.
 */
import {
    capCreditObjScore,
    capCreditCaps,
    enumSanity,
    summaryRosterNonEmpty,
    capBreakConsistency,
    flagsInitReason,
    checkEventStream,
    StreamEvent,
} from '../invariants/eventInvariants';

import 'jest';

// Minimal stream builders.
const cap = (half: number, team: 'allies' | 'axis' | 'neutral'): StreamEvent =>
    ({ event: 'flag_captured', half, new_owner: team, flag_id: 0, captor_ids: [] });
const score = (half: number, obj_score: number, extra: Partial<StreamEvent> = {}): StreamEvent =>
    ({ event: 'player_score', half, user_id: 'STEAM_0:0:1', kills: 0, deaths: 0, score: 0, obj_score, ...extra });

describe('cap-credit (obj_score)', () => {
    it('passes when a captured half also credits obj_score', () => {
        const events = [cap(1, 'allies'), score(1, 5)];
        expect(capCreditObjScore(events)).toEqual([]);
    });

    it('fires when a half has captures but obj_score stays 0 (the 487f472 regression)', () => {
        const events = [cap(1, 'allies'), cap(1, 'axis'), score(1, 0), score(1, 0)];
        const v = capCreditObjScore(events);
        expect(v).toHaveLength(1);
        expect(v[0].invariant).toBe('cap-credit-objscore');
        expect(v[0].message).toContain('half 1');
    });

    it('is per-half: a good half-1 does not mask a broken half-2', () => {
        const events = [cap(1, 'allies'), score(1, 5), cap(2, 'axis'), score(2, 0)];
        const v = capCreditObjScore(events);
        expect(v.map(x => x.message)).toEqual([expect.stringContaining('half 2')]);
    });

    it('is a no-op when no real captures happened', () => {
        expect(capCreditObjScore([score(1, 0), cap(1, 'neutral')])).toEqual([]);
    });

    it('accepts obj_score credited via a player_stats_summary row', () => {
        const summary: StreamEvent = {
            event: 'player_stats_summary', half: 1, reason: 'half_end',
            players: [{ user_id: 'STEAM_0:0:1', obj_score: 5, caps: 1 }],
        };
        expect(capCreditObjScore([cap(1, 'allies'), summary])).toEqual([]);
    });
});

describe('cap-credit (caps) — guarded, forward-looking', () => {
    it('is a no-op on a pre-caps stream (no caps field anywhere)', () => {
        // April-era data: player_score has no caps field at all.
        expect(capCreditCaps([cap(1, 'allies'), score(1, 5)])).toEqual([]);
    });

    it('passes when caps is emitted and credited', () => {
        expect(capCreditCaps([cap(1, 'allies'), score(1, 5, { caps: 1 })])).toEqual([]);
    });

    it('fires when caps is emitted but every player stays at caps 0', () => {
        const events = [cap(1, 'allies'), score(1, 5, { caps: 0 }), score(1, 7, { caps: 0 })];
        const v = capCreditCaps(events);
        expect(v).toHaveLength(1);
        expect(v[0].invariant).toBe('cap-credit-caps');
    });
});

describe('enum sanity', () => {
    it('passes on valid team / owner vocab', () => {
        const events = [
            { event: 'player_team_change', team: 'spectator', user_id: 'x' },
            cap(1, 'allies'),
        ];
        expect(enumSanity(events)).toEqual([]);
    });

    it('flags an invalid team value once per distinct value', () => {
        const events = [
            { event: 'player_spawn', team: 'british', user_id: 'x' },
            { event: 'player_spawn', team: 'british', user_id: 'y' },
        ];
        const v = enumSanity(events);
        expect(v).toHaveLength(1);
        expect(v[0].invariant).toBe('enum-team');
        expect(v[0].message).toContain('british');
    });
});

describe('summary-roster (empty match_end / half_end board)', () => {
    const connect = (uid: string, team: 'allies' | 'axis' | 'spectator'): StreamEvent =>
        ({ event: 'player_connect', user_id: uid, team });
    const disconnect = (uid: string): StreamEvent => ({ event: 'player_disconnect', user_id: uid });
    const summary = (reason: string, players: any[], half = 2): StreamEvent =>
        ({ event: 'player_stats_summary', half, reason, players });

    it('passes when a match_end summary carries rows for the live roster', () => {
        const events = [
            connect('STEAM_0:0:1', 'allies'), connect('STEAM_0:0:2', 'axis'),
            summary('match_end', [{ user_id: 'STEAM_0:0:1' }, { user_id: 'STEAM_0:0:2' }]),
        ];
        expect(summaryRosterNonEmpty(events)).toEqual([]);
    });

    it('fires when match_end is empty but players were still connected on teams (the intermission bug)', () => {
        const events = [
            connect('STEAM_0:0:1', 'allies'), connect('STEAM_0:0:2', 'axis'),
            connect('STEAM_0:0:3', 'allies'), connect('STEAM_0:0:4', 'axis'),
            summary('match_end', []),
        ];
        const v = summaryRosterNonEmpty(events);
        expect(v).toHaveLength(1);
        expect(v[0].invariant).toBe('summary-roster-nonempty');
        expect(v[0].message).toContain('4 connected players');
    });

    it('also guards half_end boards', () => {
        const events = [
            connect('STEAM_0:0:1', 'allies'), connect('STEAM_0:0:2', 'axis'),
            summary('half_end', [], 1),
        ];
        expect(summaryRosterNonEmpty(events).map(x => x.invariant)).toEqual(['summary-roster-nonempty']);
    });

    it('is a no-op when the roster legitimately drained before the boundary (everyone left)', () => {
        const events = [
            connect('STEAM_0:0:1', 'allies'), connect('STEAM_0:0:2', 'axis'),
            disconnect('STEAM_0:0:1'), disconnect('STEAM_0:0:2'),
            summary('match_end', []),
        ];
        expect(summaryRosterNonEmpty(events)).toEqual([]);
    });

    it('does not count spectators toward the expected roster', () => {
        const events = [
            connect('STEAM_0:0:1', 'spectator'), connect('STEAM_0:0:2', 'spectator'),
            summary('match_end', []),
        ];
        expect(summaryRosterNonEmpty(events)).toEqual([]);
    });

    it('ignores mid-match round_end capouts (only boundary reasons are checked)', () => {
        const events = [
            connect('STEAM_0:0:1', 'allies'), connect('STEAM_0:0:2', 'axis'),
            summary('round_end', []),
        ];
        expect(summaryRosterNonEmpty(events)).toEqual([]);
    });
});

describe('cap-break consistency (event ↔ cap_breaks accumulator, half-scoped)', () => {
    const brk = (half: number, extra: Partial<StreamEvent> = {}): StreamEvent => ({
        event: 'cap_break', half, flag_id: 0, flag_name: 'The Bridge',
        reason: 'kill', breaker_id: 'STEAM_0:0:1', broke_team: 'axis', ...extra,
    });

    it('passes when a break event and a nonzero cap_breaks row share the half', () => {
        expect(capBreakConsistency([brk(1), score(1, 0, { cap_breaks: 1 })])).toEqual([]);
    });

    it('is a no-op on a pre-feature stream (no events, no cap_breaks fields)', () => {
        expect(capBreakConsistency([score(1, 5, { caps: 1 })])).toEqual([]);
    });

    it('fires when a break event never credits the accumulator', () => {
        const v = capBreakConsistency([brk(1), score(1, 0, { cap_breaks: 0 })]);
        expect(v.map(x => x.invariant)).toEqual(['cap-break-credit']);
        expect(v[0].message).toContain('half 1');
    });

    it('fires when the accumulator moves without any break event that half', () => {
        const v = capBreakConsistency([brk(1), score(1, 0, { cap_breaks: 1 }), score(2, 0, { cap_breaks: 1 })]);
        expect(v.map(x => x.invariant)).toEqual(['cap-break-orphan-stat']);
        expect(v[0].message).toContain('half 2');
    });

    it('flags a malformed cap_break (schema check)', () => {
        const v = capBreakConsistency([brk(1, { broke_team: 'neutral' }), score(1, 0, { cap_breaks: 1 })]);
        expect(v.map(x => x.invariant)).toEqual(['cap-break-schema']);
    });

    it('accepts credit carried by a summary row instead of player_score', () => {
        const summary: StreamEvent = {
            event: 'player_stats_summary', half: 1, reason: 'round_end',
            players: [{ user_id: 'STEAM_0:0:1', cap_breaks: 1 }],
        };
        expect(capBreakConsistency([brk(1), summary])).toEqual([]);
    });

    it('is order-independent (the score may arrive before the event over HTTP)', () => {
        expect(capBreakConsistency([score(1, 0, { cap_breaks: 1 }), brk(1)])).toEqual([]);
    });
});

describe('flags_init reason schema', () => {
    const snap = (half: number, reason?: string, owner = 'neutral'): StreamEvent => {
        const e: StreamEvent = { event: 'flags_init', half, flags: [{ flag_id: 0, flag_name: 'A', owner }] };
        if (reason !== undefined) e.reason = reason;
        return e;
    };

    it('passes for every reason in the vocabulary', () => {
        const events = ['map_load', 'match_start', 'reset', 'tick'].map(r => snap(1, r));
        expect(flagsInitReason(events)).toEqual([]);
    });

    it('is a no-op on a pre-feature stream (no snapshot carries a reason)', () => {
        expect(flagsInitReason([snap(1), snap(1), snap(2)])).toEqual([]);
    });

    it('fires when only some snapshots are tagged (a missed call site)', () => {
        const v = flagsInitReason([snap(1, 'map_load'), snap(1), snap(1)]);
        expect(v.map(x => x.invariant)).toEqual(['flags-init-reason-missing']);
        expect(v[0].message).toContain('half 1');
        expect(v[0].message).toContain('2 flags_init');
    });

    it('fires on a misspelled reason — the overlay would silently stop resetting', () => {
        const v = flagsInitReason([snap(1, 'tick'), snap(1, 'restart')]);
        expect(v.map(x => x.invariant)).toEqual(['flags-init-reason-enum']);
        expect(v[0].message).toContain('restart');
    });

    it('reports each distinct bad reason once, not per event', () => {
        const v = flagsInitReason([snap(1, 'restart'), snap(1, 'restart'), snap(2, 'restart')]);
        expect(v).toHaveLength(1);
    });

    it('enumSanity also rejects a bad owner inside a snapshot', () => {
        const v = enumSanity([snap(1, 'reset', 'british')]);
        expect(v.map(x => x.invariant)).toEqual(['enum-flag-owner']);
    });
});

describe('checkEventStream', () => {
    it('aggregates violations across invariants', () => {
        const events = [cap(1, 'allies'), score(1, 0, { caps: 0 }), { event: 'player_spawn', team: 'british', user_id: 'x' }];
        const ids = checkEventStream(events).map(v => v.invariant).sort();
        expect(ids).toEqual(['cap-credit-caps', 'cap-credit-objscore', 'enum-team']);
    });

    it('returns no violations for a clean stream', () => {
        expect(checkEventStream([cap(1, 'allies'), score(1, 5, { caps: 1 })])).toEqual([]);
    });
});
