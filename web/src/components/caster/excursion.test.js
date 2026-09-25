/**
 * Depth/rear-flag geometry and the isolation state machine behind the
 * EXCURSION cue. Ported from KTPInfrastructure/scripts/excursions.py's
 * per-half math, not the whole module (see excursion.js's header) — these
 * pure pieces are the part that can drift silently from the analytics
 * definition without anyone noticing until a caster is pointed at the wrong
 * side of the map.
 */
import {
    buildCentroids, buildDepthAxis, rankRearFlags, nearestMateDistance, stepExcursion,
    MIN_SPAWN_SAMPLES, MIN_EXCURSION_SECONDS,
} from './excursion';

describe('buildCentroids', () => {
    it('averages each team\'s samples', () => {
        const c = buildCentroids({
            1: [{ x: -2000, y: -10 }, { x: -2000, y: 10 }],
            2: [{ x: 1900, y: 0 }, { x: 2100, y: 0 }],
        });
        expect(c[1]).toEqual({ x: -2000, y: 0 });
        expect(c[2]).toEqual({ x: 2000, y: 0 });
    });

    it('refuses a guess from too few samples on either side', () => {
        const tooFew = Array.from({ length: MIN_SPAWN_SAMPLES - 1 }, (_, i) => ({ x: i, y: 0 }));
        const enough = Array.from({ length: MIN_SPAWN_SAMPLES }, (_, i) => ({ x: i, y: 0 }));
        expect(buildCentroids({ 1: tooFew, 2: enough })).toBeNull();
        expect(buildCentroids({ 1: enough, 2: [] })).toBeNull();
    });
});

// West-east line, own spawns at the ends — the same shape Minimap.test.js uses.
const CENTROIDS = { 1: { x: -2000, y: 0 }, 2: { x: 2000, y: 0 } };
const FLAGS = [
    { flag_id: 0, x: -1500, y: 0 },
    { flag_id: 1, x: -750, y: 0 },
    { flag_id: 2, x: 0, y: 0 },
    { flag_id: 3, x: 750, y: 0 },
    { flag_id: 4, x: 1500, y: 0 },
];

describe('buildDepthAxis', () => {
    const depth = buildDepthAxis(CENTROIDS);

    it('is 0 at a team\'s own spawn centroid', () => {
        expect(depth(-2000, 0, 1)).toBeCloseTo(0, 9);
        expect(depth(2000, 0, 2)).toBeCloseTo(0, 9);
    });

    it('is 1 at the enemy\'s spawn centroid', () => {
        expect(depth(2000, 0, 1)).toBeCloseTo(1, 9);
        expect(depth(-2000, 0, 2)).toBeCloseTo(1, 9);
    });

    it('the two teams see the same point as complementary depths', () => {
        const x = 750;
        expect(depth(x, 0, 1) + depth(x, 0, 2)).toBeCloseTo(1, 9);
    });
});

describe('rankRearFlags', () => {
    const depth = buildDepthAxis(CENTROIDS);

    it('refuses fewer than three flags — no rear line is defined', () => {
        expect(rankRearFlags(FLAGS.slice(0, 2), depth)).toBeNull();
    });

    it('picks the deepest half of the flags per side, symmetrically', () => {
        const r = rankRearFlags(FLAGS, depth);
        // 5 flags -> floor(4/2) = 2 rear flags each side.
        expect(r[1].rearFlagIds).toEqual([4, 3]);
        expect(r[2].rearFlagIds).toEqual([0, 1]);
        expect(r[1].rearLineDepth).toBeCloseTo(r[2].rearLineDepth, 9);
    });
});

describe('nearestMateDistance', () => {
    const roster = (overrides = []) => [
        { user_id: 'me', team: 'allies', dead: false, pos: { x: 0, y: 0 } },
        { user_id: 'mate1', team: 'allies', dead: false, pos: { x: 100, y: 0 } },
        { user_id: 'mate2', team: 'allies', dead: false, pos: { x: 500, y: 0 } },
        { user_id: 'enemy', team: 'axis', dead: false, pos: { x: 10, y: 0 } },
        ...overrides,
    ];

    it('finds the nearest ALIVE teammate, ignoring the enemy and self', () => {
        const [me, ...rest] = roster();
        expect(nearestMateDistance(me, [me, ...rest])).toBe(100);
    });

    it('skips a dead teammate even if they are the closest one', () => {
        const r = roster();
        r[1] = { ...r[1], dead: true }; // mate1 now dead
        expect(nearestMateDistance(r[0], r)).toBe(500); // falls through to mate2
    });

    it('skips a teammate with no known position', () => {
        const r = roster();
        r[1] = { ...r[1], pos: null };
        expect(nearestMateDistance(r[0], r)).toBe(500);
    });

    it('is null when truly alone', () => {
        const me = { user_id: 'me', team: 'allies', dead: false, pos: { x: 0, y: 0 } };
        const enemy = { user_id: 'enemy', team: 'axis', dead: false, pos: { x: 10, y: 0 } };
        expect(nearestMateDistance(me, [me, enemy])).toBeNull();
    });
});

describe('stepExcursion', () => {
    const MS = MIN_EXCURSION_SECONDS * 1000;

    it('never starts a clock while not a candidate', () => {
        const { next, justCrossed } = stepExcursion(null, false, 0);
        expect(next).toBeNull();
        expect(justCrossed).toBe(false);
    });

    it('does not fire before the minimum duration', () => {
        let state = stepExcursion(null, true, 0).next;
        state = stepExcursion(state, true, MS - 1).next;
        expect(state.fired).toBe(false);
    });

    it('fires exactly once, the tick duration first crosses the threshold', () => {
        let state = stepExcursion(null, true, 0).next;
        const crossing = stepExcursion(state, true, MS);
        expect(crossing.justCrossed).toBe(true);
        expect(crossing.next.fired).toBe(true);

        const next = stepExcursion(crossing.next, true, MS + 1000);
        expect(next.justCrossed).toBe(false); // still isolated, but not a NEW cue
        expect(next.next.fired).toBe(true);
    });

    it('a single non-candidate tick resets the clock entirely', () => {
        let state = stepExcursion(null, true, 0).next;
        state = stepExcursion(state, true, MS - 100).next;
        const interrupted = stepExcursion(state, false, MS - 50);
        expect(interrupted.next).toBeNull();
        // Starting again needs the full duration from scratch, not a top-up.
        const restarted = stepExcursion(null, true, MS - 40);
        const after = stepExcursion(restarted.next, true, MS - 40 + MS - 1);
        expect(after.next.fired).toBe(false);
    });
});
