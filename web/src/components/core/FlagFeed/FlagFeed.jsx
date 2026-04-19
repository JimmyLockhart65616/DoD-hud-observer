import React, { useEffect, useState } from 'react';
import { humanizeFlagName } from '../Flags/humanize';

const FlagFeedItem = ({ entry, delay }) => {
    const [visible, setVisible] = useState(true);

    useEffect(() => {
        const t = setTimeout(() => setVisible(false), delay);
        return () => clearTimeout(t);
    }, [delay]);

    if (!visible) return null;

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

    // captured
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
    if (!entries || entries.length === 0) return null;
    return (
        <div className="flagfeed-wrapper">
            {entries.map((entry, i) => (
                <FlagFeedItem key={entry.id ?? i} entry={entry} delay={screentime} />
            ))}
        </div>
    );
});

export default FlagFeed;
