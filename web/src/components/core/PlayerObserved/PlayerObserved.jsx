import React, { useState, useEffect } from 'react';

const weaponImages = {};
const weaponCtx = require.context('../../screen/resources/images/weapons', false, /\.png$/);
weaponCtx.keys().forEach(key => { weaponImages[key.replace('./', '').replace('.png', '')] = weaponCtx(key); });

const classImages = {};
const classCtx = require.context('../../screen/resources/images/classes', false, /\.png$/);
classCtx.keys().forEach(key => { classImages[key.replace('./', '').replace('.png', '')] = classCtx(key); });

const ALLIED_CLASSES = ['Rifleman', 'Staff Sgt', 'Master Sgt', 'LMG', 'Sniper', 'Rocket'];
const AXIS_CLASSES   = ['Grenadier', 'Stosstruppe', 'Unteroffizier', 'Sturmtruppe', 'Scharfschütze', 'Panzerschreck', 'MG42'];

function useProneTimer(prone_since) {
    const [elapsed, setElapsed] = useState(0);
    useEffect(() => {
        if (!prone_since) { setElapsed(0); return; }
        const tick = () => setElapsed(Math.floor((Date.now() - prone_since) / 1000));
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [prone_since]);
    return elapsed;
}

const WeaponIcon = ({ weapon }) => {
    if (!weapon) return null;
    if (weaponImages[weapon]) return <img src={weaponImages[weapon]} alt={weapon} />;
    return <span className="observed-weapon-text">{weapon}</span>;
};

const ClassIcon = ({ team, classId }) => {
    if (classId === null || classId === undefined) return null;
    const key = `${team}_${classId}`;
    if (classImages[key]) return <img src={classImages[key]} alt={key} />;
    return null;
};

const PlayerObserved = React.memo(({ players }) => {
    const spectated = players.find(player => player.spectate === true);
    const prone_since = spectated ? spectated.prone_since : null;
    const elapsed = useProneTimer(prone_since);

    if (!spectated) return null;

    const isAllies = spectated.team === 'allies';
    const classNames = isAllies ? ALLIED_CLASSES : AXIS_CLASSES;
    const className = classNames[spectated.class_id] || '';
    const isProne = spectated.prone_state === 'prone' || spectated.prone_state === 'deployed';

    return (
        <div className={`player-observed ${isAllies ? 'allies-observed' : 'axis-observed'}`}>
            <div className="observed-class-icon">
                <ClassIcon team={spectated.team} classId={spectated.class_id} />
            </div>

            <div className="observed-info">
                <div className="observed-top-row">
                    <span className="observed-name">{spectated.name}</span>
                    <span className="observed-class-name">{className}</span>
                </div>
                <div className="observed-bottom-row">
                    <span className="observed-hp">{spectated.health} HP</span>
                    <div className="observed-health-bar">
                        <div
                            className={`observed-health-fill ${isAllies ? 'fill-allies' : 'fill-axis'}`}
                            style={{ width: `${spectated.health}%` }}
                        />
                    </div>
                    <span className="observed-kd">{spectated.kills}/{spectated.deaths}</span>
                    <span className="observed-weapon">
                        <WeaponIcon weapon={spectated.weapon_primary} />
                    </span>
                    {isProne && (
                        <span className="observed-prone">
                            <span className="observed-prone-label">PRONE</span>
                            {elapsed}s
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
});

export default PlayerObserved;
