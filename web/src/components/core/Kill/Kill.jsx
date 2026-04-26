import React, { useEffect, useState } from 'react';
import KillItem from './kill-item/KillItem';

// Render-time TTL filtering — see FlagFeed.jsx for the rationale. Same browser
// background-throttling vulnerability for OBS-overlay deployments.
const Kill = React.memo(({ screentime, kills }) => {
    const [now, setNow] = useState(() => Date.now());
    const hasKills = !!(kills && kills.length > 0);

    useEffect(() => {
        if (!hasKills) return undefined;
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, [hasKills]);

    if (!hasKills) return null;
    const visible = kills.filter(k => now - (k.addedAt ?? 0) <= screentime);

    return (
        <div className="wrapper">
            {visible.map(kill =>
                <KillItem
                    key={kill.id ?? `${kill.killer_id}-${kill.victim_id}-${kill.addedAt}`}
                    killinfo={kill}
                    killer={{ team: kill.killer?.team ?? 'unknown', name: kill.killer?.name ?? kill.killer_id }}
                    victim={{ team: kill.victim?.team ?? 'unknown', name: kill.victim?.name ?? kill.victim_id }}
                />
            )}
        </div>
    );
});

export default Kill;
