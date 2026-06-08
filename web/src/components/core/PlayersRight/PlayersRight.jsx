import React, { useState, useEffect } from 'react';
import { getWeaponIcon } from '../../screen/resources/weaponIcons';

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

const classImages = {};
const classCtx = require.context('../../screen/resources/images/classes', false, /^\.\/axis_.*\.png$/);
classCtx.keys().forEach(key => { classImages[key.replace('./', '').replace('.png', '')] = classCtx(key); });

const WeaponIcon = ({ weapon }) => {
    if (!weapon) return null;
    const src = getWeaponIcon(weapon);
    return src
        ? <img src={src} alt={weapon} />
        : <span className="card-weapon-text">{weapon}</span>;
};

const ClassIcon = ({ classId }) => {
    if (classId === null || classId === undefined) return null;
    const key = `axis_${classId}`;
    if (classImages[key]) return <img src={classImages[key]} alt={key} />;
    return null;
};

const PlayerCard = React.memo(({ player }) => {
    const isProne = player.prone_state === 'prone' || player.prone_state === 'deployed';
    const elapsed = useProneTimer(player.prone_since);

    const classes = ['player-card', 'player-card-axis'];
    if (player.dead) classes.push('dead');
    if (player.spectate) classes.push('spectated');
    if (isProne) classes.push('prone-active');

    if (player.dead) {
        return (
            <div className={classes.join(' ')}>
                <div className="card-top card-dead">
                    <img src={require('../../screen/resources/images/skull.png')} alt="dead" className="card-skull" />
                </div>
                <div className="card-bottom">
                    <div className="card-name">{player.name}</div>
                </div>
            </div>
        );
    }

    return (
        <div className={classes.join(' ')}>
            <div className="card-top">
                <div className="card-class-icon">
                    <ClassIcon classId={player.class_id} />
                </div>
                <div className="card-hp">{player.health}</div>
                {isProne && (
                    <div className="card-prone">
                        <span className="prone-label">PRONE</span>
                        {elapsed}s
                    </div>
                )}
            </div>
            <div className="card-health-strip">
                <div className="card-health-fill" style={{ width: `${player.health}%` }} />
            </div>
            <div className="card-bottom">
                <div className="card-name">{player.name}</div>
                <div className="card-stats">
                    <span className="card-objscore" title="Objective score (flag caps)">
                        <span className="card-stat-icon">&#9873;</span>{player.obj_score ?? 0}
                    </span>
                    <span className="card-kills">{player.kills}</span>
                    <span className="card-kd-sep">/</span>
                    <span className="card-deaths">{player.deaths}</span>
                </div>
                <div className="card-weapon">
                    <WeaponIcon weapon={player.weapon_primary} />
                </div>
            </div>
        </div>
    );
});

const PlayersRight = React.memo(({ players }) => (
    <>
        {players && players.map(player =>
            <PlayerCard key={player.user_id} player={player} />
        )}
    </>
));

export default PlayersRight;
