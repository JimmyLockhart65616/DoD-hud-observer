/**
 * Official engine team-score producer and retention contract.
 *
 * No repository suite executes Pawn, so the small ProducerMirror below is the
 * executable specification for KTPHudObserver.sma's side-map/boundary state
 * machine (the same pattern used by scoreTick.test.ts and
 * damageCorrection.test.ts). Structural assertions at the bottom pin the
 * shipped Pawn to every security-sensitive edge of that model.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { MatchRecorder } from '../handler/matchRecorder';

import 'jest';

const SOURCE = 'engine-team-score-v1';
const CANONICAL_TYPES = new Set([
    'competitive', 'scrim', '12man', 'draft', 'ktpOT', 'draftOT',
]);

interface SideMap {
    match_id: string;
    map: string;
    match_type: string;
    half: number;
    allies_team_slot: number;
    axis_team_slot: number;
}

interface Scores { allies: number; axis: number }

type ScoreRow = Record<string, string | number>;

const tupleEquals = (a: SideMap, b: SideMap, requireHalf = true): boolean =>
    a.match_id === b.match_id
    && a.map === b.map
    && a.match_type === b.match_type
    && (!requireHalf || a.half === b.half);

class ProducerMirror {
    private pending: SideMap | null = null;
    private bound: SideMap | null = null;
    private active: SideMap | null = null;
    private sequence = 0;
    private last: Scores | null = null;
    private finalized = false;

    sideMap(mapping: SideMap): void {
        this.pending = null;
        const validHalf = mapping.half === 1 || mapping.half === 2 || mapping.half >= 101;
        const validSlots = mapping.allies_team_slot > 0
            && mapping.axis_team_slot > 0
            && mapping.allies_team_slot !== mapping.axis_team_slot;
        if (!mapping.match_id || !mapping.map || !CANONICAL_TYPES.has(mapping.match_type)
            || !validHalf || !validSlots) return;
        this.pending = { ...mapping };
    }

    start(lifecycle: SideMap, scores: Scores, tick: number): ScoreRow {
        this.active = { ...lifecycle };
        this.bound = this.pending && tupleEquals(this.pending, lifecycle)
            ? { ...this.pending }
            : null;
        this.pending = null;
        this.sequence = 0;
        this.last = null;
        this.finalized = false;
        return this.bound
            ? this.official('baseline', scores, tick)
            : this.legacy(scores, tick);
    }

    observe(scores: Scores, tick: number): ScoreRow | null {
        if (!this.active || !this.bound || !tupleEquals(this.bound, this.active)) {
            return this.legacy(scores, tick);
        }
        if (this.finalized || (this.last
            && this.last.allies === scores.allies && this.last.axis === scores.axis)) return null;
        return this.official('change', scores, tick);
    }

    final(terminal: SideMap, scores: Scores, tick: number, requireHalf = true): ScoreRow | null {
        if (!this.active || !this.bound || !tupleEquals(this.bound, this.active)
            || !tupleEquals(this.bound, terminal, requireHalf)) return null;
        const row = this.official('final', scores, tick);
        this.finalized = true;
        return row;
    }

    changelevel(scores: Scores, tick: number): ScoreRow | null {
        if (!this.active || !this.bound || !tupleEquals(this.bound, this.active)) return null;
        return this.official('final', scores, tick);
    }

    private envelope(scores: Scores, tick: number): ScoreRow {
        if (!this.active) throw new Error('score row without active lifecycle');
        return {
            tick,
            match_id: this.active.match_id,
            map: this.active.map,
            match_type: this.active.match_type,
            half: this.active.half,
            event: 'team_score',
            allies_score: scores.allies,
            axis_score: scores.axis,
        };
    }

    private legacy(scores: Scores, tick: number): ScoreRow {
        return this.envelope(scores, tick);
    }

    private official(sampleKind: 'baseline' | 'change' | 'final', scores: Scores,
                     tick: number): ScoreRow {
        if (!this.bound) throw new Error('official row without side map');
        this.sequence++;
        this.last = { ...scores };
        return {
            ...this.envelope(scores, tick),
            allies_team_slot: this.bound.allies_team_slot,
            axis_team_slot: this.bound.axis_team_slot,
            event_sequence: this.sequence,
            source: SOURCE,
            sample_kind: sampleKind,
        };
    }
}

const sideMap = (overrides: Partial<SideMap> = {}): SideMap => ({
    match_id: 'match-a',
    map: 'dod_anzio',
    match_type: 'competitive',
    half: 1,
    allies_team_slot: 1,
    axis_team_slot: 2,
    ...overrides,
});

const stableScores = (row: ScoreRow): Record<number, number> => ({
    [Number(row.allies_team_slot)]: Number(row.allies_score),
    [Number(row.axis_team_slot)]: Number(row.axis_score),
});

describe('official engine team-score producer contract', () => {
    it('orders two halves despite a tick restart and preserves carryover through the side swap', () => {
        const p = new ProducerMirror();
        const h1 = sideMap();
        p.sideMap(h1);
        const h1Rows = [
            p.start(h1, { allies: 0, axis: 0 }, 10.25),
            p.observe({ allies: 1, axis: 0 }, 120.5),
            // A capout/multi-point jump is one real observation; never invent
            // intermediate 2-0/3-0 rows.
            p.observe({ allies: 4, axis: 0 }, 120.5),
            p.final(h1, { allies: 4, axis: 0 }, 1300.75),
        ].filter((r): r is ScoreRow => r !== null);

        const h2 = sideMap({ half: 2, allies_team_slot: 2, axis_team_slot: 1 });
        p.sideMap(h2);
        const h2Rows = [
            // Engine sides swapped: stable slot 1's carried four points are now
            // on Axis, while slot 2 remains on Allies.
            p.start(h2, { allies: 0, axis: 4 }, 0.2),
            p.observe({ allies: 2, axis: 4 }, 0.2),
            p.final(h2, { allies: 2, axis: 4 }, 1250.1),
        ].filter((r): r is ScoreRow => r !== null);

        expect(h1Rows.map(r => [r.tick, r.event_sequence, r.sample_kind])).toEqual([
            [10.25, 1, 'baseline'], [120.5, 2, 'change'],
            [120.5, 3, 'change'], [1300.75, 4, 'final'],
        ]);
        expect(h2Rows.map(r => [r.tick, r.event_sequence, r.sample_kind])).toEqual([
            [0.2, 1, 'baseline'], [0.2, 2, 'change'], [1250.1, 3, 'final'],
        ]);
        expect(stableScores(h1Rows[h1Rows.length - 1])).toEqual({ 1: 4, 2: 0 });
        expect(stableScores(h2Rows[0])).toEqual({ 1: 4, 2: 0 });
    });

    it('fails official publication closed for missing, stale, unknown and invalid-half maps', () => {
        const cases: SideMap[] = [
            sideMap({ map: 'dod_stale' }),
            sideMap({ match_type: 'unknown' }),
            sideMap({ half: 100 }),
        ];

        for (const proposed of cases) {
            const p = new ProducerMirror();
            p.sideMap(proposed);
            const baseline = p.start(sideMap(), { allies: 3, axis: 2 }, 1.25);
            const change = p.observe({ allies: 4, axis: 2 }, 2.5);
            expect(baseline.source).toBeUndefined();
            expect(change?.source).toBeUndefined();
            expect(baseline).not.toHaveProperty('event_sequence');
            expect(change).not.toHaveProperty('allies_team_slot');
        }
    });

    it('rejects a stale terminal tuple without finalizing the current stream', () => {
        const p = new ProducerMirror();
        const current = sideMap();
        p.sideMap(current);
        p.start(current, { allies: 0, axis: 0 }, 1);
        expect(p.final(sideMap({ map: 'dod_stale' }), { allies: 1, axis: 0 }, 100)).toBeNull();
        const good = p.final(current, { allies: 1, axis: 0 }, 100);
        expect(good).toMatchObject({ source: SOURCE, sample_kind: 'final', event_sequence: 2 });
        // Explicit changelevel duplicate remains ordered and retains real DODX state.
        expect(p.changelevel({ allies: 1, axis: 0 }, 100)).toMatchObject({
            source: SOURCE, sample_kind: 'final', event_sequence: 3,
        });
    });

    it('authorizes half-end identity before the 2s guard so stale then valid still finalizes', () => {
        const current = sideMap();
        let lastAcceptedAt = 0;
        const acceptHalfEnd = (terminal: SideMap, now: number, haveCurrentMap = true): string => {
            // Mirrors ktp_half_end: authorization must be the first operation;
            // stale mapped identities do not mutate the dedupe clock, while an
            // unmapped legacy stream keeps its historical duplicate guard.
            const authorized = haveCurrentMap && tupleEquals(current, terminal);
            if (haveCurrentMap && !authorized) return 'rejected';
            if (lastAcceptedAt > 0 && now - lastAcceptedAt < 2) return 'deduped';
            lastAcceptedAt = now;
            return authorized ? 'official' : 'legacy';
        };

        expect(acceptHalfEnd(sideMap({ map: 'dod_stale' }), 10)).toBe('rejected');
        expect(lastAcceptedAt).toBe(0);
        expect(acceptHalfEnd(current, 10.1)).toBe('official');
        expect(lastAcceptedAt).toBe(10.1);
        expect(acceptHalfEnd(current, 10.2)).toBe('deduped');
        expect(lastAcceptedAt).toBe(10.1);

        lastAcceptedAt = 0;
        expect(acceptHalfEnd(current, 20, false)).toBe('legacy');
        expect(acceptHalfEnd(current, 20.1, false)).toBe('deduped');
    });

    it('takes OT mappings as authoritative and resets sequence for every exact round/new match', () => {
        const p = new ProducerMirror();
        const ot1 = sideMap({ match_type: 'ktpOT', half: 101 });
        p.sideMap(ot1);
        expect(p.start(ot1, { allies: 5, axis: 4 }, 0.1)).toMatchObject({
            half: 101, allies_team_slot: 1, axis_team_slot: 2, event_sequence: 1,
        });

        // Supplied mapping, not odd/even arithmetic in the observer.
        const ot2 = sideMap({ match_type: 'ktpOT', half: 102,
            allies_team_slot: 2, axis_team_slot: 1 });
        p.sideMap(ot2);
        expect(p.start(ot2, { allies: 4, axis: 5 }, 0.05)).toMatchObject({
            half: 102, allies_team_slot: 2, axis_team_slot: 1, event_sequence: 1,
        });

        const next = sideMap({ match_id: 'match-b' });
        p.sideMap(next);
        expect(p.start(next, { allies: 0, axis: 0 }, 3.75)).toMatchObject({
            match_id: 'match-b', event_sequence: 1, sample_kind: 'baseline',
        });
    });

    it('official rows are team-only and every one has the complete provenance envelope', () => {
        const p = new ProducerMirror();
        const mapping = sideMap();
        p.sideMap(mapping);
        const rows = [
            p.start(mapping, { allies: 0, axis: 0 }, 1.01),
            p.observe({ allies: 1, axis: 0 }, 2.02)!,
            p.final(mapping, { allies: 1, axis: 0 }, 3.03)!,
        ];
        for (const row of rows) {
            expect(row).toEqual(expect.objectContaining({
                event: 'team_score', source: SOURCE,
                match_id: 'match-a', map: 'dod_anzio', match_type: 'competitive', half: 1,
                tick: expect.any(Number), event_sequence: expect.any(Number),
                allies_team_slot: 1, axis_team_slot: 2,
                allies_score: expect.any(Number), axis_score: expect.any(Number),
                sample_kind: expect.stringMatching(/^(baseline|change|final)$/),
            }));
            expect(Object.keys(row).filter(k => /player|user|steam|name|team1|team2/i.test(k))).toEqual([]);
        }
    });
});

describe('official engine team-score raw retention', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ktp-team-score-')); });
    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it('appends enriched rows byte-for-byte compatibly with events.jsonl', () => {
        const recorder = new MatchRecorder(tmpDir);
        recorder.startMatch('match-a', 'dod_anzio', 0, 1, 'test-server');

        const p = new ProducerMirror();
        const mapping = sideMap();
        p.sideMap(mapping);
        const rows = [
            p.start(mapping, { allies: 0, axis: 0 }, 1.25),
            p.observe({ allies: 3, axis: 0 }, 2.5)!,
            p.final(mapping, { allies: 3, axis: 0 }, 2.5)!,
        ];
        rows.forEach(row => recorder.recordEvent('match-a', row, 'test-server'));

        expect(recorder.getEvents('match-a')).toEqual(rows);
        const raw = fs.readFileSync(path.join(tmpDir, 'match-a', 'events.jsonl'), 'utf8');
        expect(raw.trim().split('\n')).toHaveLength(3);
        expect(raw).toContain('"source":"engine-team-score-v1"');
        expect(raw).toContain('"sample_kind":"final"');
    });
});

describe('shipped Pawn official-score wiring', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../KTPHudObserver.sma'), 'utf8');

    const body = (start: string, end: string): string => {
        const from = source.indexOf(start);
        const to = source.indexOf(end, from + start.length);
        expect(from).toBeGreaterThanOrEqual(0);
        expect(to).toBeGreaterThan(from);
        return source.slice(from, to);
    };

    it('binds the exact public side-map ABI and never infers OT parity', () => {
        expect(source).toMatch(/public ktp_match_side_map\(const matchId\[\], const mapName\[\], const matchType\[\], half,\s*allies_team_slot, axis_team_slot\)/s);
        const mappingBody = body('public ktp_match_side_map(', '// half: 1=1st half');
        expect(mappingBody).toContain('score_half_is_valid(half)');
        expect(mappingBody).not.toMatch(/half\s*%\s*2|half\s*&\s*1/);
        expect(source).toContain('return half == 1 || half == 2 || half >= 101;');
    });

    it('constructs official rows only from DODX and the complete bound tuple', () => {
        expect(source).toContain('#define TEAM_SCORE_SOURCE "engine-team-score-v1"');
        const official = body('stock bool:emit_official_team_score(', '// Preserve historical pub');
        expect(official.match(/dodx_get_team_score\(TEAM_(ALLIES|AXIS)\)/g)).toHaveLength(2);
        expect(official).not.toMatch(/\bdod_get_team_score\s*\(/);
        for (const field of ['allies_score', 'axis_score', 'allies_team_slot', 'axis_team_slot',
            'event_sequence', 'source', 'sample_kind']) {
            expect(official).toContain(`^"${field}^"`);
        }
        const current = body('stock bool:score_mapping_is_current()', 'stock bool:score_mapping_matches_lifecycle');
        for (const identity of ['g_matchId', 'g_matchMap', 'g_matchType', 'g_matchHalf']) {
            expect(current).toContain(identity);
        }
    });

    it('keeps legacy fallback distinguishable and gates terminal forwards before finals', () => {
        const legacy = body('stock emit_legacy_team_score(', 'public ktp_match_side_map(');
        expect(legacy).not.toContain('TEAM_SCORE_SOURCE');
        expect(legacy).not.toContain('event_sequence');
        expect(legacy).not.toContain('team_slot');

        const halfEnd = body('public ktp_half_end(', 'stock do_roster_dump()');
        const authorization = halfEnd.indexOf('score_mapping_matches_lifecycle(');
        expect(authorization).toBeGreaterThanOrEqual(0);
        expect(authorization).toBeLessThan(halfEnd.indexOf('g_lastHalfEndFwdAt'));
        expect(authorization).toBeLessThan(halfEnd.indexOf('{^"event^":^"half_end^"'));
        expect(halfEnd).toMatch(/have_current_score_map && !score_authorized[\s\S]*return;[\s\S]*g_lastHalfEndFwdAt = now/);
        expect(halfEnd).toMatch(/score_mapping_matches_lifecycle\(\s*matchId, map, matchType, half, true\)[\s\S]*emit_official_team_score\("final", true\);\s*g_score_half_finalized = true;\s*}\s*else/);
        const matchEnd = body('public ktp_match_end(', 'public ktp_half_end(');
        expect(matchEnd.indexOf('score_mapping_matches_lifecycle(matchId, map, matchType, 0, false)'))
            .toBeLessThan(matchEnd.indexOf('{^"event^":^"ktp_match_end^"'));
        expect(source).toMatch(/public server_changelevel\(map\[\]\)[\s\S]*emit_official_team_score\("final", true\)/);
        expect(source).toMatch(/public plugin_end\(\)[\s\S]*emit_official_team_score\("final", true\)/);
    });

    it('uses fractional gametime plus a reset-before-baseline sequence', () => {
        const post = body('stock post_event(', 'public on_post_complete');
        expect(post).toContain('"tick^":%.2f');
        expect(post).toContain('get_gametime()');
        const start = body('public ktp_match_start(', '// RoundState message');
        expect(start.indexOf('score_mapping_bind(matchId, map, matchType, half)'))
            .toBeLessThan(start.indexOf('emit_official_team_score("baseline", true)'));
        const clear = body('stock score_mapping_clear_bound()', 'stock score_mapping_reset_level');
        expect(clear).toContain('g_score_event_sequence = 0');
    });
});
