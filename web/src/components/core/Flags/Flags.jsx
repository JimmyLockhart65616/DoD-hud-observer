import React from 'react';
import { humanizeFlagName } from './humanize';

const FlagItem = ({ flag }) => {
    const {
        flag_name, owner, capping_team,
        contested, progress,
        allies_count, axis_count,
        allies_numcap, axis_numcap,
    } = flag;

    let ownerClass = 'flag-neutral';
    if (owner === 'allies') ownerClass = 'flag-allies';
    if (owner === 'axis')   ownerClass = 'flag-axis';

    const isContested = contested && capping_team;
    const isCapping = capping_team && !contested;
    const ac = allies_count || 0;
    const xc = axis_count || 0;
    const an = allies_numcap || 1;
    const xn = axis_numcap || 1;
    const hasZonePlayers = ac > 0 || xc > 0;

    const progressPct = progress || 0;

    return (
        <div className={`flag-item ${ownerClass}${isContested ? ' flag-contested' : ''}`}>
            <div className="flag-header">
                <span className="flag-name">{humanizeFlagName(flag_name)}</span>

                {isContested && (
                    <span className="flag-status flag-status-contested">CONTESTED</span>
                )}
                {isCapping && (
                    <span className={`flag-status flag-capping flag-capping-${capping_team}`}>
                        capping
                    </span>
                )}
            </div>

            {/* Zone occupancy counts (per-player names not available in extension mode) */}
            {hasZonePlayers && (
                <div className="flag-zone-players">
                    {ac > 0 && (
                        <span className="flag-zone-name allies-zone">Allies {ac}/{an}</span>
                    )}
                    {xc > 0 && (
                        <span className="flag-zone-name axis-zone">Axis {xc}/{xn}</span>
                    )}
                </div>
            )}

            {/* Cap progress bar */}
            {isCapping && progressPct > 0 && (
                <div className="flag-progress-bar">
                    <div
                        className={`flag-progress-fill flag-progress-${capping_team}`}
                        style={{ width: `${Math.min(100, progressPct)}%` }}
                    />
                </div>
            )}
        </div>
    );
};

const Flags = React.memo(({ flags }) => {
    if (!flags || flags.length === 0) return null;

    return (
        <div className="flags-container">
            {flags.map(flag =>
                <FlagItem key={flag.flag_id} flag={flag} />
            )}
        </div>
    );
});

export default Flags;
