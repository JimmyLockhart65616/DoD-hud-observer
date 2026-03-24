import React from 'react';
import { useHudStore } from '../Socket/Socket';

function humanizeFlagName(name) {
    return name
        .replace(/^POINT_/i, '')
        .replace(/_/g, ' ')
        .split(' ')
        .map(w => w.length <= 3
            ? w.toUpperCase()
            : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
        )
        .join(' ');
}

function resolveNames(steamIds, allPlayers) {
    if (!steamIds || steamIds.length === 0) return [];
    return steamIds.map(id => {
        const p = allPlayers.find(pl => pl.user_id === id);
        return p ? p.name : null;
    }).filter(Boolean);
}

const FlagItem = ({ flag, allPlayers }) => {
    const {
        flag_name, owner, capping_team, captor_ids,
        contested, progress,
        allies_in_zone, axis_in_zone,
    } = flag;

    let ownerClass = 'flag-neutral';
    if (owner === 'allies') ownerClass = 'flag-allies';
    if (owner === 'axis')   ownerClass = 'flag-axis';

    const isContested = contested && capping_team;
    const isCapping = capping_team && !contested;

    // Resolve zone player names
    const alliesOnCap = resolveNames(allies_in_zone, allPlayers);
    const axisOnCap   = resolveNames(axis_in_zone, allPlayers);
    const hasZonePlayers = alliesOnCap.length > 0 || axisOnCap.length > 0;

    // Resolve captor names (who gets credit for the cap)
    const captorNames = resolveNames(captor_ids, allPlayers);

    // Progress percentage (0-100 from plugin)
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

            {/* Captor names (who is credited) */}
            {captorNames.length > 0 && isCapping && (
                <div className={`flag-captors flag-captors-${capping_team}`}>
                    {captorNames.join(', ')}
                </div>
            )}

            {/* Zone occupancy (who is physically on the point) */}
            {hasZonePlayers && (
                <div className="flag-zone-players">
                    {alliesOnCap.map(name => (
                        <span key={name} className="flag-zone-name allies-zone">{name}</span>
                    ))}
                    {axisOnCap.map(name => (
                        <span key={name} className="flag-zone-name axis-zone">{name}</span>
                    ))}
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
    const alliesPlayers = useHudStore(s => s.allies_players);
    const axisPlayers   = useHudStore(s => s.axis_players);

    if (!flags || flags.length === 0) return null;

    const allPlayers = [...alliesPlayers, ...axisPlayers];

    return (
        <div className="flags-container">
            {flags.map(flag =>
                <FlagItem key={flag.flag_id} flag={flag} allPlayers={allPlayers} />
            )}
        </div>
    );
});

export default Flags;
