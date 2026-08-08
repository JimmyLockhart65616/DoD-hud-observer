import React from 'react';

// Seconds until a side's next DoD reinforcement wave, plus how many players it
// brings back ("⟳3s +4").
//
// DoD respawn is a per-TEAM wave, not a per-player countdown: the clock arms on
// that side's first death and returns everyone waiting at once, so this is one
// number for the whole team and the two sides' phases are unrelated. `seconds`
// is null whenever the clock is idle (nobody dead) or unreadable — render
// nothing rather than a stale or fabricated countdown.
//
// Recomputes from the anchor on every tick instead of decrementing, for the same
// reason Timer.jsx does: OBS throttles background-tab intervals to ~1 Hz, and a
// decrementing counter would silently fall behind and never catch up. `secondsAt`
// is the browser instant the value was RECEIVED, and events are released by the
// HLTV delay buffer rather than read live, so the countdown is already in
// broadcast frame with no delay arithmetic here.
// How long past zero to keep showing "0s" before deciding the feed died. The
// plugin re-sends at 4 Hz, so a live wave re-anchors ~250ms after it lands and
// never approaches this; only a wedged poll task, a run of failed POSTs or a
// dropped server leaves an anchor to run out. Without it the pill would sit at
// "0s" on air forever, which reads as a wave that never arrives.
const STALE_AFTER_ZERO_SEC = 3;

const WavePill = ({ seconds, secondsAt, pending, side, frozen }) => {

    const [display, setDisplay] = React.useState(null);

    React.useEffect(() => {
        if (seconds == null || secondsAt == null) {
            setDisplay(null);
            return;
        }

        const update = () => {
            const remaining = seconds - (Date.now() - secondsAt) / 1000;
            setDisplay(remaining < -STALE_AFTER_ZERO_SEC ? null : Math.max(0, Math.ceil(remaining)));
        };

        update();

        if (frozen) return;

        const id = setInterval(update, 200);
        return () => clearInterval(id);
    }, [seconds, secondsAt, frozen]);

    // No respawns happen during freeze or after round end, so a pill left on
    // screen there would be counting down to nothing.
    if (display == null || frozen) return null;

    const classes = ['wave-pill', `wave-pill-${side}`];
    if (display <= 3) classes.push('hot');

    return (
        <span className={classes.join(' ')} title="Reinforcement wave">
            <span className="wave-glyph">⟳</span>{display}s
            {pending > 0 && <span className="wave-pending">+{pending}</span>}
        </span>
    );
};

export default WavePill;
