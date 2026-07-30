import React from 'react';
import { humanizeFlagName } from '../core/Flags/humanize';

/**
 * Flag ownership, left to right in flag_id order.
 *
 * Ownership ONLY — no cap progress, no contested state, no zone counts. The
 * backend deliberately doesn't send them: `flag_captured` updates only `owner`
 * and there is no `flag_zone_players` reducer arm, so those fields stay frozen
 * at whatever the last `flags_init` carried. Rendering them would show stale
 * numbers as though they were live.
 */
const HqFlagStrip = ({ flags }) => {
    if (!flags || flags.length === 0) return <div className="hq-flags" />;

    return (
        <div className="hq-flags">
            {flags.map(flag => (
                <div
                    className={`hq-flag hq-flag-${flag.owner || 'neutral'}`}
                    key={flag.flag_id}
                >
                    <span className="hq-flag-pip" />
                    <span className="hq-flag-name">{humanizeFlagName(flag.flag_name)}</span>
                </div>
            ))}
        </div>
    );
};

export default HqFlagStrip;
