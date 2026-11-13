import {
    setHudClockSource, nextHudTimerAt, runNextHudTimer, clearHudTimers,
} from '../clock/hudClock';

/**
 * Virtual-time replay driver. Owns the HUD clock while it exists: hudNow()
 * returns `now`, which only moves when the engine is told to advance or seek.
 *
 * Events go out in file order (the play order replayClock was built for). Before
 * each one the clock is moved to that event's own instant, so every receipt
 * stamp the store takes lands exactly where it would have at 1x, whatever the
 * speed and however large the step. Virtual timers (hudAfter) fire in time order
 * between events.
 *
 * Seeking forward is just advancing. Seeking backward resets the HUD and
 * re-feeds from the first event: the store's half/carry state machine only
 * runs forwards, so there is no cheaper way back that is also correct.
 *
 * @param events  play-ordered events
 * @param clock   one epoch-ms instant per event, never decreasing
 * @param emit    (event) => void, delivers one event to the store
 * @param reset   () => void, returns the HUD to a never-seen-an-event state
 * @param batch   (fn) => void, wraps a burst so React renders once at the end
 */
export function createReplayEngine({ events, clock, emit, reset, batch = fn => fn() }) {
    const start = clock.length ? clock[0] : 0;
    const end = clock.length ? clock[clock.length - 1] : 0;
    let idx = 0;
    let now = start;

    clearHudTimers();
    setHudClockSource(() => now);

    function step(t) {
        for (;;) {
            const nextEvent = idx < events.length ? clock[idx] : Infinity;
            const nextTimer = nextHudTimerAt() ?? Infinity;
            const next = Math.min(nextEvent, nextTimer);
            if (next > t) break;
            if (next > now) now = next;
            if (nextTimer <= nextEvent) runNextHudTimer();
            else emit(events[idx++]);
        }
        if (t > now) now = t;
    }

    return {
        start,
        end,
        get now() { return now; },
        /** Index of the next event to emit; events.length once all are out. */
        get index() { return idx; },
        get done() { return idx >= events.length && now >= end; },

        advanceTo(t) {
            batch(() => step(Math.min(t, end)));
        },

        seek(t) {
            const target = Math.max(start, Math.min(t, end));
            batch(() => {
                if (target < now) {
                    reset();
                    clearHudTimers();
                    idx = 0;
                    now = start;
                }
                step(target);
            });
        },

        dispose() {
            clearHudTimers();
            setHudClockSource(null);
        },
    };
}
