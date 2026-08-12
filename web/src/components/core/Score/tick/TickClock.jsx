import React from 'react';

// Seconds until the map's next TERRITORIAL scoring tick — DoD's periodic team
// point award for holding control points.
//
// Deliberately NOT styled as a game HUD element, unlike WavePill's recreation of
// the `hud_reinforcements` sprite. The DoD client shows this clock nowhere at
// all, so there is no in-game panel to be faithful to, and dressing it up as one
// would imply players can see what the broadcast sees. It renders as a quiet
// line under the half clock instead, and must not compete with it.
//
// Recomputes from the anchor every tick instead of decrementing, for the same
// reason Timer.jsx and WavePill.jsx do: OBS throttles background-tab intervals
// to ~1 Hz, and a decrementing counter would silently fall behind and never
// catch up. `secondsAt` is the browser instant the value was RECEIVED, and
// events are released by the HLTV delay buffer rather than read live, so the
// countdown is already in broadcast frame with no delay arithmetic here.

// How long past zero to keep showing 0:00 before deciding the feed died. The
// plugin re-sends at 4 Hz and re-anchors on every observed tick, so a live clock
// never approaches this; only a wedged poll task, a run of failed POSTs or a
// dropped server leaves an anchor to run out. Without it the panel would sit at
// 0:00 on air forever, which reads as an award that never lands.
const STALE_AFTER_ZERO_SEC = 3;

const TickClock = ({ seconds, secondsAt, frozen }) => {

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

    // The master does not award during freeze or after round end, so a countdown
    // left on screen there would be counting down to nothing.
    if (display == null || frozen) return null;

    const mm = Math.floor(display / 60);
    const ss = display % 60;

    const classes = ['tick-clock'];
    if (display <= 3) classes.push('hot');

    return (
        <span className={classes.join(' ')} title="Next scoring tick">
            {mm}:{String(ss).padStart(2, '0')}
        </span>
    );
};

export default TickClock;
