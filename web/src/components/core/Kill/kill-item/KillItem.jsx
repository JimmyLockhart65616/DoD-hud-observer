import React, { useEffect, useState } from 'react';

// Pre-build weapon image map at compile time
const weaponImages = {};
const weaponCtx = require.context('../../../screen/resources/images/weapons', false, /\.png$/);
weaponCtx.keys().forEach(key => { weaponImages[key.replace('./', '').replace('.png', '')] = weaponCtx(key); });

const KillItem = ({ killinfo, killer, victim, delay }) => {

    const [visible, setVisible] = useState(true);

    useEffect(() => {
        const t = setTimeout(() => setVisible(false), delay);
        return () => clearTimeout(t);
    }, [delay]);

    if (!visible) return <div />;

    const isSuicide  = killinfo.kill_type === 'suicide';
    const isTeamkill = killinfo.kill_type === 'teamkill';

    return (
        <div className={`kill${isTeamkill ? ' teamkill' : ''}`}>

            {isSuicide ? (
                <>
                    <img
                        style={{ height: '16px', width: '16px', marginLeft: '4px' }}
                        src={require(`../../../screen/resources/images/skull.png`)}
                        alt="suicide"
                    />
                    <span className={`${victim.team}-style`}>{victim.name}</span>
                </>
            ) : (
                <>
                    {killinfo.streak >= 3 &&
                        <span className="kill-streak-badge">{killinfo.streak}K</span>
                    }

                    <span className={`${killer.team}-style`}>{killer.name}</span>

                    {killinfo.killer_prone &&
                        <span className="kill-prone-badge">PRONE</span>
                    }

                    <WeaponIcon weapon={killinfo.weapon} />

                    {killinfo.headshot &&
                        <img
                            className="kill-headshot-icon"
                            src={require(`../../../screen/resources/images/headshot.png`)}
                            alt="headshot"
                            title="headshot"
                        />
                    }

                    {killinfo.victim_prone &&
                        <span className="kill-prone-badge">PRONE</span>
                    }

                    <span className={`${victim.team}-style`}>{victim.name}</span>
                </>
            )}

        </div>
    );
};

// Weapon icon — falls back to text if image not in pre-built map
const WeaponIcon = ({ weapon }) => {
    if (!weapon) return null;
    if (weaponImages[weapon]) return <img src={weaponImages[weapon]} alt={weapon} style={{ margin: '0 4px' }} />;
    return <span className="weapon-text">{weapon}</span>;
};

export default KillItem;
