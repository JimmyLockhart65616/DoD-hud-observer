// `tick` and `plugin_sent_at` are stamped in the same post_event() call, so within
// one map their difference is constant to within plugin_sent_at's one-second floor
// (measured: under 1 s of drift across a half on three recorded matches). The
// halftime changelevel moves it by the length of the map that just ended. So pace
// by `tick` inside a map, and use the wall stamp only to find where a new map
// starts and to place it. A late row from an earlier map (the old map's final
// player_disconnect rows arrive interleaved with the new map's first rows) is
// held at the current instant, not replayed at its old tick.
export const NEW_MAP_MS = 30000; // same threshold as hltvDelayBuffer's TICK_RESET_THRESHOLD_S

/**
 * The replay schedule plus what it learned building it.
 *   clock  one epoch-ms instant per event, never decreasing
 *   mapOf  index into `maps` of the map each event was placed on (the newest
 *          map so far for a row with no usable stamps)
 *   maps   [{ offset, firstTick, maxTick, startAt }] in the order they opened
 */
export function replayTimeline(events) {
    const out = [];
    const mapOf = [];
    const maps = [];
    let high = null;
    for (const e of events) {
        const wall = e.plugin_sent_at;
        const tick = e.tick;
        let mi = maps.length - 1;
        if (typeof wall === 'number' && typeof tick === 'number') {
            const offset = wall - tick * 1000;
            let m = null;
            for (let j = maps.length - 1; j >= 0; j--) {
                if (Math.abs(maps[j].offset - offset) < NEW_MAP_MS) { m = maps[j]; mi = j; break; }
            }
            if (!m) {
                m = { offset, firstTick: tick, maxTick: tick, startAt: Math.max(high ?? wall, wall) };
                maps.push(m);
                mi = maps.length - 1;
            }
            if (m === maps[maps.length - 1]) {
                if (tick > m.maxTick) m.maxTick = tick;
                const at = m.startAt + (m.maxTick - m.firstTick) * 1000;
                if (high === null || at > high) high = at;
            }
        } else if (typeof wall === 'number' && (high === null || wall > high)) {
            high = wall;
        }
        out.push(high);
        mapOf.push(Math.max(0, mi));
    }
    const first = out.find(v => v !== null) ?? 0;
    return { clock: out.map(v => (v === null ? first : v)), mapOf, maps };
}

export function replayClock(events) {
    return replayTimeline(events).clock;
}

/**
 * Where a row from a second stream recorded alongside events.jsonl (the 4 Hz
 * player_state.jsonl) falls on the replay schedule: on the map whose offset it
 * shares, at that map's tick pace. null when it matches no map the events
 * opened, e.g. a row from before the match's first recorded event.
 */
export function placeOnClock(row, maps) {
    const wall = row.plugin_sent_at;
    const tick = row.tick;
    if (typeof wall !== 'number' || typeof tick !== 'number') return null;
    const offset = wall - tick * 1000;
    for (let j = maps.length - 1; j >= 0; j--) {
        const m = maps[j];
        if (Math.abs(m.offset - offset) < NEW_MAP_MS) {
            return Math.max(m.startAt, m.startAt + (tick - m.firstTick) * 1000);
        }
    }
    return null;
}
