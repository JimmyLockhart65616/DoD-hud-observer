import React from 'react';

/**
 * One team's roster column: a label row plus exactly `rows` player rows.
 *
 * The fixed row count is load-bearing, not cosmetic. Strips share the canvas
 * height via `grid-auto-rows: 1fr`, so a 4-man team that rendered only 4 rows
 * would shrink its own strip and shift every strip below it — the board would
 * visibly re-flow on each connect and disconnect.
 */
const HqRoster = ({ team, players, rows = 6 }) => {
    const shown = players.slice(0, rows);
    const padding = Math.max(0, rows - shown.length);

    return (
        <div className={`hq-roster hq-roster-${team}`}>
            <div className="hq-roster-label">{team === 'allies' ? 'ALLIES' : 'AXIS'}</div>
            {shown.map(p => (
                <div className="hq-roster-row" key={p.user_id}>
                    <span className="hq-roster-name" title={p.name}>{p.name}</span>
                    <span className="hq-roster-kd">
                        <span className="hq-kd-k">{p.kills}</span>
                        <span className="hq-kd-sep">/</span>
                        <span className="hq-kd-d">{p.deaths}</span>
                    </span>
                </div>
            ))}
            {Array.from({ length: padding }, (_, i) => (
                <div className="hq-roster-row hq-roster-row-empty" key={`pad-${i}`} />
            ))}
            {players.length > rows && (
                <div className="hq-roster-overflow">+{players.length - rows} more</div>
            )}
        </div>
    );
};

export default HqRoster;
