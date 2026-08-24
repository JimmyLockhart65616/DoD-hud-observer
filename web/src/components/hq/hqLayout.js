/**
 * Row-height arithmetic for the HQ board.
 *
 * The board is authored on a fixed 1920x1080 canvas (Hq.jsx scales it to the
 * display), so the strips have an exact, known height budget to divide. The
 * original `grid-auto-rows: 1fr` divided it evenly and its comment anticipated
 * "1 station or 6" — at the 24 the fleet reached on 2026-08-23 that produced
 * 31px rows holding 104px of content, every one of them clipped by the strips'
 * own `overflow: hidden`: station numbers sliced in half, server names gone.
 *
 * So rows come in two sizes now. A compact row is one line of status/map/
 * score/clock/flags and gets whatever height is left; an expanded row also
 * carries the two 6-player rosters and needs a fixed, much larger one. This is
 * kept out of CSS for the same reason `useCanvasScale` is: the compact height
 * depends on how many rows are expanded, which no CSS length can express.
 */

/** Canvas 1080 − 14px top/bottom padding − 72px topbar − 10px topbar margin. */
export const STRIPS_AVAIL_PX = 1080 - 28 - 72 - 10;

export const STRIP_GAP_PX = 3;

/**
 * Height of an open strip in compact mode. MEASURED against the rendered board,
 * not guessed — two earlier values were wrong in opposite directions (150 pushed
 * the column past the canvas; 172 cropped the sixth roster row).
 *
 * A full-size open strip measures 182: six 23px roster rows (138) + the roster
 * label (28) + 8px top/bottom strip padding (16). Two of those plus 22 readable
 * compact rows does not fit in 970, so compact-mode open strips tighten their
 * roster rows to 19px (Hq.css), giving 114 + 28 + 16 = 158. Change either number
 * and the other has to move with it — hqLayout.test.js checks the sum fits.
 */
export const EXPANDED_H_PX = 158;

/**
 * Above this many simultaneously-open stations the board stops opening them
 * automatically and shows every station compact instead.
 *
 * Three open strips cannot fit alongside 21 readable compact rows, and there is
 * no principled way to pick which two of three live matches to detail. So past
 * the cap the board does the thing it is good at — the overview — and leaves
 * the choice to whoever is watching it. Clicking still opens as many as wanted.
 */
export const MAX_AUTO_OPEN = 2;

/**
 * Floor/ceiling on a compact row. The floor is the point below which the server
 * name stops being readable across a room — past it the board gives up on
 * fitting and scrolls, which is a visible, recoverable degradation rather than
 * the silent clipping this replaces.
 */
export const COMPACT_MIN_PX = 24;
export const COMPACT_MAX_PX = 46;

/**
 * Height for each compact row given how many rows are expanded.
 *
 * Returns COMPACT_MAX when nothing needs the space, so a 3-station local dev
 * board doesn't stretch its rows to a third of the screen each.
 */
export function compactRowHeight(total, expandedCount, avail = STRIPS_AVAIL_PX) {
    const compactCount = Math.max(0, total - expandedCount);
    if (compactCount === 0) return COMPACT_MAX_PX;

    const gaps = Math.max(0, total - 1) * STRIP_GAP_PX;
    const free = avail - gaps - expandedCount * EXPANDED_H_PX;
    const each = Math.floor(free / compactCount);

    return Math.max(COMPACT_MIN_PX, Math.min(COMPACT_MAX_PX, each));
}

/**
 * Whether the board still fits its canvas at the given mix. False means the
 * strips container has to scroll — see COMPACT_MIN_PX. Only reachable with an
 * implausible number of simultaneous matches (5+ of 24 expanded at once).
 */
export function fitsCanvas(total, expandedCount, avail = STRIPS_AVAIL_PX) {
    const compactCount = Math.max(0, total - expandedCount);
    const gaps = Math.max(0, total - 1) * STRIP_GAP_PX;
    const used = gaps
        + expandedCount * EXPANDED_H_PX
        + compactCount * compactRowHeight(total, expandedCount, avail);
    return used <= avail;
}

/**
 * A station with nothing to watch: no KTP match and nobody connected.
 *
 * Deliberately NOT idle: NO_SIGNAL and STALE. A station that stopped reporting
 * is the single most important thing an operations board can tell you, so it
 * survives `?hideIdle=1` — the filter drops quiet stations, not broken ones.
 */
export function isIdleStation(s) {
    return s.status === 'BETWEEN' && !(s.playerCount > 0);
}
