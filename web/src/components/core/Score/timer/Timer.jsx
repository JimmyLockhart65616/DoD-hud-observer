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

    const [display, setDisplay] = React.useState(timeleft ?? 0);

    React.useEffect(() => {
        if (timeleft == null || timeleftAt == null) return;

        const update = () => {
            const elapsed = Math.floor((Date.now() - timeleftAt) / 1000);
            setDisplay(Math.max(0, timeleft - elapsed));
        };

        update();

        if (frozen) return;

        const id = setInterval(update, 1000);
        return () => clearInterval(id);
    }, [timeleft, timeleftAt, frozen]);

    return (
        <span>
            {format(display)}
        </span>
    );
}

export default Timer;
