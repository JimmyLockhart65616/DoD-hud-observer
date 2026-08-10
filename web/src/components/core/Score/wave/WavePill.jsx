import React from 'react';

// Seconds until a side's next DoD reinforcement wave, styled as the game's own
// `hud_reinforcements` panel: a gunmetal plate with an embossed stencil label
// and a brass-bezel housing of four recessed MM:SS windows.
//
// The look is taken from the real sprite, not invented — `hud_layout.spr` region
// (81,0,129,58) per dod/sprites/hud.txt, palette sampled off it: plate
// #4a4a4a→#383531, bezel #4e452f/#2f2718, near-black recesses, #a7a7a7
// highlights. MM:SS (four windows + colon) is the game's layout; our waves are
// always under a minute, so it reads 00:07, exactly as the client would show it.
//
// DoD respawn is a per-TEAM wave, not a per-player countdown: the clock arms on
// that side's first death and returns everyone waiting at once. `seconds` is
// null whenever the clock is idle (nobody dead) or unreadable — render nothing
// rather than a stale or fabricated countdown.
//
// Recomputes from the anchor every tick instead of decrementing, for the same
// reason Timer.jsx does: OBS throttles background-tab intervals to ~1 Hz, and a
// decrementing counter would silently fall behind and never catch up.
// `secondsAt` is the browser instant the value was RECEIVED, and events are
// released by the HLTV delay buffer rather than read live, so the countdown is
// already in broadcast frame with no delay arithmetic here.

// How long past zero to keep showing 00:00 before deciding the feed died. The
// plugin re-sends at 4 Hz, so a live wave re-anchors ~250ms after it lands and
// never approaches this; only a wedged poll task, a run of failed POSTs or a
// dropped server leaves an anchor to run out. Without it the panel would sit at
// 00:00 on air forever, which reads as a wave that never arrives.
const STALE_AFTER_ZERO_SEC = 3;

const Digit = ({ value }) => (
    <span className="wave-digit">{value}</span>
);

const WavePill = ({ seconds, secondsAt, side, frozen }) => {

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

    // No respawns happen during freeze or after round end, so a panel left on
    // screen there would be counting down to nothing.
    if (display == null || frozen) return null;

    const mm = Math.floor(display / 60);
    const ss = display % 60;
    const pad = (n) => String(n).padStart(2, '0');
    const [m1, m2] = pad(mm);
    const [s1, s2] = pad(ss);

    const classes = ['wave-panel', `wave-panel-${side}`];
    if (display <= 3) classes.push('hot');

    return (
        <span className={classes.join(' ')} title="Reinforcements">
            <span className="wave-label">REINFORCEMENTS</span>
            <span className="wave-readout">
                <Digit value={m1} />
                <Digit value={m2} />
                <span className="wave-colon" />
                <Digit value={s1} />
                <Digit value={s2} />
            </span>
        </span>
    );
};

export default WavePill;
