/*
 * Excursion geometry, adapted LIVE from `KTPInfrastructure/scripts/excursions.py`
 * (excursions_v1) -- not vendored verbatim like flagswing, because the Python
 * runs once over a whole half's stored position history (spawn-boundary
 * lookups, ±2.5s sample matching, a gap-tolerant window) and none of that
 * exists live. What's kept is the part that generalises: depth has no
 * per-map table, it's the projection onto the own-spawn -> enemy-spawn axis,
 * 0 at your own spawn and 1 at theirs; rear flags are the deepest half of
 * them, ranked per side.
 *
 * Isolation stays the Python module's own flat default (1200 units) rather
 * than the per-map p80 calibration `infra-hidden-value-plays` measured,
 * because that table is keyed by map name and nothing in this store carries
 * the current map -- adding it would be a backend change, which the rest of
 * the cue rail deliberately avoids. Noted in the PR; same class of
 * uncalibrated-first-pass as the SWING threshold in momentum.js.
 */

const TEAM_NUM = { allies: 1, axis: 2 };

export const ISOLATION_UNITS = 1200;
export const MIN_EXCURSION_SECONDS = 10;
// How long the page watches live spawns before freezing the centroid --
// mirrors the Python's "samples within 4s of the start boundary"; a bit
// looser here because a live 'golive' edge is a coarser signal than a
// per-player life-start boundary.
export const SPAWN_BOOTSTRAP_MS = 5000;
export const MIN_SPAWN_SAMPLES = 2;

/**
 * Averages `{x,y}` samples per team into a centroid. Returns null if either
 * side has fewer than MIN_SPAWN_SAMPLES -- an excursion needs both spawns
 * placed, and a guess from one or two stragglers is worse than no axis at
 * all (this module's whole design is "unavailable", never "wrong and silent").
 */
export function buildCentroids(samplesByTeam) {
    const out = {};
    for (const team of [1, 2]) {
        const pts = samplesByTeam[team] || [];
        if (pts.length < MIN_SPAWN_SAMPLES) return null;
        out[team] = {
            x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
            y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
        };
    }
    return out;
}

/** `{depth(x, y, team)}` -- 0 at team's own spawn, 1 at the enemy's. */
export function buildDepthAxis(centroids) {
    const dx = centroids[2].x - centroids[1].x;
    const dy = centroids[2].y - centroids[1].y;
    const length = Math.hypot(dx, dy) || 1;
    const ux = dx / length, uy = dy / length;
    return function depth(x, y, team) {
        const d = ((x - centroids[1].x) * ux + (y - centroids[1].y) * uy) / length;
        return team === 1 ? d : 1 - d;
    };
}

/**
 * The deepest floor((n-1)/2) flags per side, and the shallowest depth among
 * them (the "rear line" a runner has to cross to count as deep at all).
 * `flags`: [{flag_id, x, y}]. Needs >= 3 flags, same as the Python.
 */
export function rankRearFlags(flags, depth) {
    if (flags.length < 3) return null;
    const k = Math.max(1, Math.floor((flags.length - 1) / 2));
    const out = {};
    for (const team of [1, 2]) {
        const ranked = flags
            .map(f => ({ flag_id: f.flag_id, d: depth(f.x, f.y, team) }))
            .sort((a, b) => b.d - a.d);
        out[team] = {
            rearFlagIds: ranked.slice(0, k).map(r => r.flag_id),
            rearLineDepth: ranked[k - 1].d,
        };
    }
    return out;
}

/** Nearest ALIVE teammate to `player`, or null if they're the only one left. */
export function nearestMateDistance(player, roster) {
    let best = null;
    for (const p of roster) {
        if (p.user_id === player.user_id || p.team !== player.team) continue;
        if (p.dead || !p.pos) continue;
        const d = Math.hypot(player.pos.x - p.pos.x, player.pos.y - p.pos.y);
        if (best === null || d < best) best = d;
    }
    return best;
}

/**
 * One player's excursion state machine. `prev` is `{since}` or null.
 * `isCandidate` is this tick's "alive, past the rear line, no mate within
 * ISOLATION_UNITS" test. Live ticks arrive reliably (4 Hz), so unlike the
 * Python this needs no gap tolerance -- a single false tick ends it.
 * Returns `{next, justCrossed}`: `next` to store, `justCrossed` true on the
 * exact tick duration first reaches MIN_EXCURSION_SECONDS (fire a cue then,
 * not on every later tick while still isolated).
 */
export function stepExcursion(prev, isCandidate, now) {
    if (!isCandidate) return { next: null, justCrossed: false };
    const since = prev ? prev.since : now;
    const wasFired = prev ? prev.fired : false;
    const fired = wasFired || (now - since) >= MIN_EXCURSION_SECONDS * 1000;
    return { next: { since, fired }, justCrossed: fired && !wasFired };
}

export { TEAM_NUM };
