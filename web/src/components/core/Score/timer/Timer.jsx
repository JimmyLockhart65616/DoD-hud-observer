import React from 'react';

const padTime = time => {
    return String(time).length === 1 ? `0${time}` : `${time}`;
};

const format = time => {
    if (time < 0) time = 0;
    const minutes = Math.floor(time / 60);
    const seconds = time % 60;
    return `${minutes}:${padTime(seconds)}`;
};

const Timer = ({ timeleft, timeleftAt, frozen }) => {

    const [display, setDisplay] = React.useState(Math.floor(timeleft ?? 0));

    React.useEffect(() => {
        if (timeleft == null || timeleftAt == null) return;

        // Fractional countdown, floored only at display. The old form floored
        // ELAPSED on a 1s interval whose phase was unrelated to the anchor, so
        // the digit could sit up to ~2s behind the true clock (and the phase
        // re-randomized on every time_sync re-anchor). timeleft itself is
        // fractional since plugin 2.1.0; flooring the REMAINDER reproduces the
        // DoD client's own display rounding, and the 200ms cadence flips the
        // digit within 200ms of the true boundary. setState with an unchanged
        // value is a no-op re-render-wise, so the fast interval stays cheap.
        const update = () => {
            const remaining = timeleft - (Date.now() - timeleftAt) / 1000;
            setDisplay(Math.max(0, Math.floor(remaining)));
        };

        update();

        if (frozen) return;

        const id = setInterval(update, 200);
        return () => clearInterval(id);
    }, [timeleft, timeleftAt, frozen]);

    return (
        <span>
            {format(display)}
        </span>
    );
}

export default Timer;
