import React from 'react';
import { getWeaponIcon } from '../../../screen/resources/weaponIcons';

// Visibility/TTL is handled by the parent (Kill.jsx) — this component just
// renders. The previous useState/setTimeout self-hide broke under browser
// background-tab throttling.
const KillItem = ({ killinfo, killer, victim }) => {
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
                    {/* Keep the weapon icon on a self-frag when it resolves to a
                        sprite (e.g. a grenade self-kill — DODX attributes the nade).
                        Falls / console / "none" deaths have no sprite, so this
                        renders nothing extra: plain skull + name, as before. */}
                    <SuicideWeaponIcon weapon={killinfo.weapon} />
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
    const src = getWeaponIcon(weapon);
    return src
        ? <img src={src} alt={weapon} style={{ margin: '0 4px' }} />
        : <span className="weapon-text">{weapon}</span>;
};

// Suicide weapon icon — render ONLY when the weapon resolves to a real sprite
// (grenade/grenade2). Unlike the normal kill row, this never text-falls-back:
// fall/drown/console deaths report "none" (or a spriteless weapon), and a stray
// "none" label next to the skull reads as noise. Sprite-or-nothing keeps the
// self-frag clean while restoring the nade icon casters expect.
const SuicideWeaponIcon = ({ weapon }) => {
    const src = weapon ? getWeaponIcon(weapon) : null;
    if (!src) return null;
    return <img src={src} alt={weapon} style={{ margin: '0 4px' }} />;
};

export default KillItem;
