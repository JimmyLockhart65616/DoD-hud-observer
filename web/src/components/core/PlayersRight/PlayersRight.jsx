import React, { useState, useEffect } from 'react';
import { getWeaponIcon } from '../../screen/resources/weaponIcons';
import { IconTarget, IconSkull, IconFlag, IconGrenade } from '../../screen/resources/CardIcons';

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
                <div className="card-dead-row">
                    <img src={require('../../screen/resources/images/skull.png')} alt="dead" className="card-skull" />
                    <div className="card-name">{player.name}</div>
                </div>
            </div>
        );
    }

    return (
        <div className={classes.join(' ')}>
            {/* Damage popup: pure CSS-animation fade (ends invisible), re-keyed per
                hit so it replays. No JS timer — survives OBS background-tab throttling. */}
            {player.last_damage_at && (
                <div className="card-damage-pop" key={player.last_damage_id}>-{player.last_damage}</div>
            )}

            {/* Health bar on top — ghost trail (OBS-safe) unchanged. */}
            <div className="card-health-strip">
                <div className="card-health-ghost" style={{ width: `${player.health}%` }} />
                <div className="card-health-fill" style={{ width: `${player.health}%` }} />
            </div>

            <div className="card-header">
                <span className="card-class-icon">
                    <ClassIcon classId={player.class_id} />
                </span>
                <span className="card-name">{player.name}</span>
                {isProne && (
                    <span className="card-prone">
                        <span className="prone-label">PRONE</span>{elapsed}s
                    </span>
                )}
            </div>

            <div className="card-bottom">
                <div className="card-stats">
                    <span className="card-stat card-kills"><IconTarget />{player.kills}</span>
                    <span className="card-stat card-deaths"><IconSkull />{player.deaths}</span>
                    <span className="card-stat card-objscore" title="Objective score (flag caps)">
                        <IconFlag />{player.obj_score ?? 0}
                    </span>
                </div>
                <div className="card-loadout">
                    <span className="card-weapon">
                        <WeaponIcon weapon={player.weapon_active ?? player.weapon_primary} />
                    </span>
                    <span className={`card-nades${player.nades > 0 ? '' : ' nades-empty'}`}
                        title={`${player.nades ?? 0} grenade(s)`}>
                        <IconGrenade />{player.nades ?? 0}
                    </span>
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
