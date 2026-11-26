// The "demo reads M:SS" conversion: between a replay instant and the round
// clock a viewer sees on screen in the HLTV demo of the same half.
//
// The on-screen clock is the anchor, not the demo's own playback time. A demo
// is one file per half, and HLTV starts it when it reconnects to the server at
// the map load, delayed by the proxy, so the demo's elapsed time has no fixed
// offset from anything we record. The clock it shows is the game's timeleft,
// which half_start / round_start / time_sync carry, so typing what the demo
// reads needs no offset at all.
//
// Halves are bounded by MAP as well as by half_start. After the halftime
// changelevel the plugin keeps stamping `half: 1` (the match stays active
// through halftime) while time_sync reports the new map's warmup clock, and on
// a recorded match that clock passed through the same 19:47 the first half had
// read. Anchors on a map the half did not start on are warmup, not the half.

const ANCHOR_EVENTS = new Set(['half_start', 'round_start', 'time_sync']);

export function halfLabel(half) {
    if (half >= 101) return `OT${half - 100}`;
    return `H${half}`;
}

/**
 * @param events  the replay's event list, in play order
 * @param clock   replayTimeline(events).clock
 * @param mapOf   replayTimeline(events).mapOf
 * @returns [{ half, map, start, end, anchors: [{ v, timeleft }] }] in play order
 */
export function buildClockTimeline(events, clock, mapOf) {
    const halves = [];
    let cur = null;
    const lastOnMap = {};
    events.forEach((e, i) => { lastOnMap[mapOf[i]] = clock[i]; });

    events.forEach((e, i) => {
        if (e.event === 'half_start' && typeof e.half === 'number') {
            cur = { half: e.half, map: mapOf[i], start: clock[i], end: clock[i], anchors: [] };
            halves.push(cur);
        } else if (!cur && ANCHOR_EVENTS.has(e.event) && typeof e.half === 'number'
            && typeof e.timeleft === 'number') {
            // The recording began mid-half with no half_start; take the
            // envelope's half for what was missed.
            cur = { half: e.half, map: mapOf[i], start: clock[i], end: clock[i], anchors: [] };
            halves.push(cur);
        }
        if (!cur || mapOf[i] !== cur.map) return;
        if (ANCHOR_EVENTS.has(e.event) && typeof e.timeleft === 'number') {
            cur.anchors.push({ v: clock[i], timeleft: e.timeleft });
        }
    });

    // A half runs until the next half begins or its map ends, whichever is first.
    halves.forEach((h, k) => {
        const next = halves[k + 1];
        const mapEnd = lastOnMap[h.map] ?? h.start;
        h.end = next ? Math.min(next.start, mapEnd) : mapEnd;
    });
    return halves.filter(h => h.anchors.length > 0);
}

/** What the clock read at replay instant v: same arithmetic as Timer.jsx. */
export function clockAt(timeline, v) {
    for (const h of timeline) {
        if (v < h.anchors[0].v || v > h.end) continue;
        let a = h.anchors[0];
        for (const x of h.anchors) {
            if (x.v <= v) a = x; else break;
        }
        const remaining = a.timeleft - (v - a.v) / 1000;
        return { half: h.half, seconds: Math.max(0, Math.floor(remaining)) };
    }
    return null;
}

/**
 * The earliest replay instant in `half` at which the clock read `seconds`
 * (whole seconds, as displayed), or null if it never did.
 */
export function findClock(timeline, half, seconds) {
    for (const h of timeline) {
        if (h.half !== half) continue;
        for (let k = 0; k < h.anchors.length; k++) {
            const a = h.anchors[k];
            const until = k + 1 < h.anchors.length ? h.anchors[k + 1].v : h.end;
            if (a.timeleft < seconds) continue;
            // The display shows `seconds` once the remainder drops below seconds+1.
            const v = a.timeleft >= seconds + 1
                ? a.v + (a.timeleft - (seconds + 1)) * 1000 + 1
                : a.v;
            if (v < until || (k + 1 === h.anchors.length && v <= until)) {
                return Math.ceil(v);
            }
        }
    }
    return null;
}

/** "14:32" or "1432" → 872; anything else → null. */
export function parseClock(text) {
    const m = /^\s*(\d{1,2}):?([0-5]\d)\s*$/.exec(text ?? '');
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
}

export function formatClock(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}
