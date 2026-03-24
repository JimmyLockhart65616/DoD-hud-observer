import React from 'react';
import KillItem from './kill-item/KillItem';



const Kill = React.memo(({ screentime, kills }) => {
    return (
        <div className="wrapper">
            {kills && kills.map((kill, index) =>
                <KillItem
                    key={index}
                    killinfo={kill}
                    killer={{ team: kill.killer?.team ?? 'unknown', name: kill.killer?.name ?? kill.killer_id }}
                    victim={{ team: kill.victim?.team ?? 'unknown', name: kill.victim?.name ?? kill.victim_id }}
                    delay={screentime}
                />
            )}
        </div>
    );
});

export default Kill;