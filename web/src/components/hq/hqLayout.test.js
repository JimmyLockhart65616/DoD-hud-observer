/**
 * Regression pin for the HQ board at fleet scale.
 *
 * On 2026-08-23 the HUD was enabled on all 24 KTP instances. The board's
 * `grid-auto-rows: 1fr` then handed each strip 31px to render 104px of content
 * and `overflow: hidden` swallowed the rest — station numbers cut in half,
 * server names gone entirely. These tests assert the arithmetic that replaced
 * it actually fits the canvas, so the next fleet expansion fails here rather
 * than on the venue wall.
 */
import {
    compactRowHeight,
    fitsCanvas,
    isIdleStation,
    STRIPS_AVAIL_PX,
    STRIP_GAP_PX,
    EXPANDED_H_PX,
    COMPACT_MIN_PX,
    COMPACT_MAX_PX,
    MAX_AUTO_OPEN,
} from './hqLayout';

/** What the rendered column actually consumes at a given mix. */
const usedPx = (total, open) =>
    Math.max(0, total - 1) * STRIP_GAP_PX
    + open * EXPANDED_H_PX
    + (total - open) * compactRowHeight(total, open);

describe('compactRowHeight', () => {
    it('fits all 24 stations on the canvas with none expanded', () => {
        expect(usedPx(24, 0)).toBeLessThanOrEqual(STRIPS_AVAIL_PX);
        expect(fitsCanvas(24, 0)).toBe(true);
    });

    it('gives a 24-station board a readable row, not the 31px that broke it', () => {
        const h = compactRowHeight(24, 0);
        expect(h).toBeGreaterThan(31);
        expect(h).toBeGreaterThanOrEqual(COMPACT_MIN_PX);
        expect(h).toBeLessThanOrEqual(COMPACT_MAX_PX);
    });

    it('still fits when a match opens one station to full detail', () => {
        expect(fitsCanvas(24, 1)).toBe(true);
        expect(usedPx(24, 1)).toBeLessThanOrEqual(STRIPS_AVAIL_PX);
    });

    it('still fits with two concurrent matches, the realistic event ceiling', () => {
        expect(fitsCanvas(24, 2)).toBe(true);
    });

    it('fits at the automatic open cap, which is the point of the cap', () => {
        // MAX_AUTO_OPEN exists so the board never opens more strips than it can
        // hold. If someone raises it, this fails rather than the venue wall.
        expect(fitsCanvas(24, MAX_AUTO_OPEN)).toBe(true);
    });

    it('shrinks compact rows as more stations open, never the reverse', () => {
        const heights = [0, 1, 2, 3].map(open => compactRowHeight(24, open));
        for (let i = 1; i < heights.length; i++) {
            expect(heights[i]).toBeLessThanOrEqual(heights[i - 1]);
        }
    });

    it('does not stretch a small board into a few enormous rows', () => {
        // Local dev runs 1-3 stations. Dividing the canvas evenly there would
        // give each row a third of the screen.
        expect(compactRowHeight(3, 0)).toBe(COMPACT_MAX_PX);
        expect(compactRowHeight(1, 0)).toBe(COMPACT_MAX_PX);
    });

    it('never returns a height below the readability floor', () => {
        for (let open = 0; open <= 24; open++) {
            expect(compactRowHeight(24, open)).toBeGreaterThanOrEqual(COMPACT_MIN_PX);
        }
    });

    it('reports the canvas as overflowing rather than silently clipping', () => {
        // The floor means an implausible number of concurrent matches cannot be
        // absorbed. That case must be visible to the caller so it can scroll.
        expect(fitsCanvas(24, 10)).toBe(false);
    });

    it('handles a board with every station expanded', () => {
        expect(compactRowHeight(24, 24)).toBe(COMPACT_MAX_PX);
        expect(() => fitsCanvas(24, 24)).not.toThrow();
    });
});

describe('isIdleStation', () => {
    const station = (status, playerCount) => ({ status, playerCount });

    it('treats an empty standby server as idle', () => {
        expect(isIdleStation(station('BETWEEN', 0))).toBe(true);
    });

    it('does not hide a pub server with players on it', () => {
        expect(isIdleStation(station('BETWEEN', 9))).toBe(false);
    });

    it('does not hide a station running a match', () => {
        for (const s of ['LIVE', 'WARMUP', 'GOLIVE', 'HALFTIME', 'OTBREAK', 'FINAL']) {
            expect(isIdleStation(station(s, 0))).toBe(false);
        }
    });

    it('NEVER hides a station that stopped reporting', () => {
        // A dead or rebuilding station is the single most important thing an
        // operations board can surface. hideIdle drops quiet stations, not
        // broken ones.
        expect(isIdleStation(station('NO_SIGNAL', 0))).toBe(false);
        expect(isIdleStation(station('STALE', 0))).toBe(false);
    });

    it('tolerates a missing player count', () => {
        expect(isIdleStation({ status: 'BETWEEN' })).toBe(true);
    });
});
