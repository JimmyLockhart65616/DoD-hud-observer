/**
 * The world -> panel transform.
 *
 * Everything here fails SILENTLY if it regresses — a mirrored or squashed map
 * still renders, still looks like a map, and is wrong in a way nobody notices
 * until a caster calls a push the wrong way on air. Hence tests for the
 * geometry rather than for the markup.
 */
import { buildTransform } from './Minimap';

// A plausible five-flag line, ordered west to east.
const FLAGS = [
    { flag_id: 0, x: -1495, y: -326 },
    { flag_id: 1, x: 1040, y: -288 },
    { flag_id: 2, x: 448, y: 800 },
    { flag_id: 3, x: -698, y: 923 },
    { flag_id: 4, x: 1375, y: 1682 },
];

describe('buildTransform', () => {
    // GoldSrc Y increases north; SVG Y increases downward. Plotting raw mirrors
    // the map top to bottom.
    it('flips Y so north is up', () => {
        const t = buildTransform(FLAGS);
        const south = t.toPanel(0, -1000);
        const north = t.toPanel(0, 1000);

        expect(north.py).toBeLessThan(south.py);
    });

    it('keeps X increasing to the right', () => {
        const t = buildTransform(FLAGS);
        expect(t.toPanel(1000, 0).px).toBeGreaterThan(t.toPanel(-1000, 0).px);
    });

    // A non-uniform fit would stretch a long map to fill the panel and
    // misrepresent every distance on it.
    it('scales both axes identically', () => {
        const t = buildTransform(FLAGS);
        const origin = t.toPanel(0, 0);
        const dx = t.toPanel(500, 0).px - origin.px;
        const dy = origin.py - t.toPanel(0, 500).py;

        expect(Math.abs(dx - dy)).toBeLessThan(0.001);
    });

    it('places the flag bounding box inside the panel', () => {
        const t = buildTransform(FLAGS);
        for (const f of FLAGS) {
            const { px, py } = t.toPanel(f.x, f.y);
            expect(px).toBeGreaterThanOrEqual(0);
            expect(px).toBeLessThanOrEqual(320);
            expect(py).toBeGreaterThanOrEqual(0);
            expect(py).toBeLessThanOrEqual(320);
        }
    });

    // Padding exists so a player pushing past the outermost objective still
    // lands on the panel rather than being clamped to its edge.
    it('leaves room outside the outermost flags', () => {
        const t = buildTransform(FLAGS);
        const xs = FLAGS.map(f => t.toPanel(f.x, f.y).px);

        expect(Math.min(...xs)).toBeGreaterThan(1);
        expect(Math.max(...xs)).toBeLessThan(319);
    });

    describe('degenerate input', () => {
        // Exact (0,0) is the plugin reporting an unpopulated CP, not a flag at
        // the world centre. Including it stretches the box across half the world
        // and squashes every real flag into a corner.
        it('ignores unpopulated (0,0) flags', () => {
            const withZero = [...FLAGS, { flag_id: 5, x: 0, y: 0 }];
            const a = buildTransform(FLAGS).toPanel(FLAGS[0].x, FLAGS[0].y);
            const b = buildTransform(withZero).toPanel(FLAGS[0].x, FLAGS[0].y);

            expect(b.px).toBeCloseTo(a.px, 6);
            expect(b.py).toBeCloseTo(a.py, 6);
        });

        it('returns null with fewer than two usable flags', () => {
            expect(buildTransform([{ flag_id: 0, x: 100, y: 100 }])).toBeNull();
            expect(buildTransform([{ flag_id: 0, x: 0, y: 0 }, { flag_id: 1, x: 0, y: 0 }])).toBeNull();
        });

        // Pre-2.8.0 plugins send flags with no coordinates at all.
        it('returns null when flags carry no coordinates', () => {
            expect(buildTransform([{ flag_id: 0 }, { flag_id: 1 }])).toBeNull();
        });

        it('returns null on empty or missing input', () => {
            expect(buildTransform([])).toBeNull();
            expect(buildTransform(undefined)).toBeNull();
        });

        // Several flags on one coordinate is a divide-by-zero smear, not a map.
        it('returns null when every flag shares a coordinate', () => {
            expect(buildTransform([
                { flag_id: 0, x: 500, y: 500 },
                { flag_id: 1, x: 500, y: 500 },
            ])).toBeNull();
        });
    });
});
