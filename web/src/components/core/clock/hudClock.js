// The HUD's notion of "now".
//
// Every countdown, TTL and receipt stamp in the overlay (Timer, wave pills, the
// scoring tick, kill/flag feed expiry, stats-board TTLs, prone timers) used to
// read Date.now() directly. That is right live, where an event's receipt instant
// IS broadcast time, and wrong in a replay: pausing didn't stop any of those
// clocks, 8x playback let a 20s kill-feed TTL run for 160 game-seconds, and a
// seek that re-feeds events in one burst would stamp every one of them with the
// same instant.
//
// So they read hudNow() instead. Live, nothing installs a source and it IS
// Date.now(). Replay installs one that returns the replay's virtual time, and
// while it re-feeds events it moves that time to each event's own instant before
// emitting it, so every stamp lands where it would have landed at 1x.
//
// hudAfter() is the same split for the one timer the store schedules (the 5s
// round_end revive): a real setTimeout live, and in a replay a virtual timer
// that the replay engine fires in time order between events, so a seek past it
// applies it and a paused replay holds it.

let source = null;
let pending = [];      // virtual timers: { at, seq, fn }
let seq = 0;

export function hudNow() {
    return source ? source() : Date.now();
}

/** Install a virtual clock (a function returning epoch-ms), or pass null to go
 * back to the wall clock. Removing the source drops any virtual timers. */
export function setHudClockSource(fn) {
    source = typeof fn === 'function' ? fn : null;
    if (!source) pending = [];
}

// Same argument order as setTimeout, so it is a drop-in at the call site.
export function hudAfter(fn, ms) {
    if (!source) return setTimeout(fn, ms);
    pending.push({ at: source() + ms, seq: seq++, fn });
    return null;
}

/** Due time of the earliest virtual timer, or null when none is pending. */
export function nextHudTimerAt() {
    let best = null;
    for (const t of pending) {
        if (best === null || t.at < best.at || (t.at === best.at && t.seq < best.seq)) best = t;
    }
    return best ? best.at : null;
}

/** Fire the earliest virtual timer. The caller moves the clock to its due
 * time first, so anything the timer stamps is stamped at that instant. */
export function runNextHudTimer() {
    let idx = -1;
    for (let i = 0; i < pending.length; i++) {
        const t = pending[i];
        if (idx < 0 || t.at < pending[idx].at || (t.at === pending[idx].at && t.seq < pending[idx].seq)) idx = i;
    }
    if (idx < 0) return;
    const [t] = pending.splice(idx, 1);
    t.fn();
}

export function clearHudTimers() {
    pending = [];
}
