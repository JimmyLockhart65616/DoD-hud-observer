import React, { useEffect, useState } from 'react';
import { humanizeFlagName } from '../Flags/humanize';

// Render-time TTL filtering. The previous implementation used per-item
// setTimeout to flip a `visible` flag, but browsers throttle setTimeout to
// ~1Hz in inactive tabs — when the OBS overlay sits behind a windowed game,
// items never hide and the feed accumulates indefinitely (observed in prod
// 2026-04-26). Filtering at render time using `entry.addedAt` instead means:
//   - When new events arrive, the parent re-renders and stale items drop out
//     immediately, no timer needed.
//   - During quiet periods we drive a 1s ticker so items can age out without
//     waiting for the next event. setInterval is throttled in inactive tabs
//     too, but that's fine — when the tab refocuses, the next render filters
//     by current Date.now() and stale items disappear at once.

const FlagFeedItem = ({ entry }) => {
    if (entry.kind === 'cap_break_kill') {
        // An enemy killed a capper on the point. Styled in the breaker's team
        // colour; names the player who made the defensive stop.
        const team = entry.breaker_team;
        return (
            <div className={`flagfeed-item flagfeed-break flagfeed-${team}`}>
                <span className="flagfeed-icon">!</span>
                <div className="flagfeed-body">
                    <span className="flagfeed-tag flagfeed-tag-break">CAP BREAK</span>
                    <span className="flagfeed-flag">{humanizeFlagName(entry.flag_name)}</span>
                    <span className={`flagfeed-team flagfeed-team-${team}`}>{entry.breaker_name}</span>
                </div>
            </div>
        );
    }
    if (entry.kind === 'cap_break') {
        const team = entry.contesting_team;
        const label = team === 'allies' ? 'Allies' : 'Axis';
        const count = entry.contester_count || 0;
        return (
            <div className={`flagfeed-item flagfeed-break flagfeed-${team}`}>
                <span className="flagfeed-icon">!</span>
                <div className="flagfeed-body">
                    <span className="flagfeed-tag flagfeed-tag-break">CAP BREAK</span>
                    <span className="flagfeed-flag">{humanizeFlagName(entry.flag_name)}</span>
                    <span className={`flagfeed-team flagfeed-team-${team}`}>
                        {label}{count > 0 ? ` ×${count}` : ''}
                    </span>
                </div>
            </div>
        );
    }

    const team = entry.new_owner;
    const label = team === 'allies' ? 'Allies' : 'Axis';
    const names = (entry.captors || []).map(p => p.name).filter(Boolean);
    return (
        <div className={`flagfeed-item flagfeed-captured flagfeed-${team}`}>
            <span className="flagfeed-icon">★</span>
            <div className="flagfeed-body">
                <span className={`flagfeed-tag flagfeed-tag-${team}`}>{label.toUpperCase()} CAPTURED</span>
                <span className="flagfeed-flag">{humanizeFlagName(entry.flag_name)}</span>
                {names.length > 0 && (
                    <span className={`flagfeed-captors flagfeed-team-${team}`}>
                        {names.join(', ')}
                    </span>
                )}
            </div>
        </div>
    );
};

const FlagFeed = React.memo(({ entries, screentime }) => {
    const [now, setNow] = useState(() => Date.now());
    const hasEntries = !!(entries && entries.length > 0);

    // Drive a 1s ticker only while there are entries that could expire.
    // Stops the interval when the feed is empty so we're not spinning forever.
    useEffect(() => {
        if (!hasEntries) return undefined;
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, [hasEntries]);

    if (!hasEntries) return null;
    const visible = entries.filter(e => now - (e.addedAt ?? 0) <= screentime);
    if (visible.length === 0) return null;

    return (
        <div className="flagfeed-wrapper">
            {visible.map(entry => (
                <FlagFeedItem key={entry.id} entry={entry} />
            ))}
        </div>
    );
});

export default FlagFeed;
