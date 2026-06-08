// Shared weapon-icon loader + name normalization.
//
// The weapon strings the HUD receives are the dodx `xmod_get_wpnlogname` values
// (KTPAMXX/modules/dod/dodx/Utils.cpp `weaponData[]`), emitted RAW by KTPHudObserver.sma
// (no remap). Sprite filenames in images/weapons/ are those lognames exactly, so a
// literal `weaponImages[weapon]` lookup hits. `getWeaponIcon` applies an alias map
// first to (a) collapse rifle-butt melee variants onto one sprite, (b) bridge
// legacy/idealized synonyms (the mocker + old replays emit e.g. "k98" instead of
// the real "kar"), then falls back to a literal lookup. Returns the image src, or
// null so the caller can render its own text fallback.
//
// Source art is converted by scripts/convert-weapon-sprites.ts (npm run assets:weapons).

const weaponImages = {};
const ctx = require.context('./images/weapons', false, /\.png$/);
ctx.keys().forEach((key) => {
    weaponImages[key.replace('./', '').replace('.png', '')] = ctx(key);
});

const WEAPON_ALIASES = {
    // rifle-butt melee variants -> generic butt-smack sprite
    garandbutt: 'buttsmack',
    k43butt: 'buttsmack',
    enf_bayonet: 'buttsmack',
    // Axis combat knife shares the spade sprite
    gerknife: 'spade',
    // legacy / idealized synonyms (mocker, CLAUDE.md examples, old fixtures/replays)
    k98: 'kar',
    k98s: 'scopedkar',
    carbine: 'm1carbine', // no sprite yet -> still text-falls-back, but keeps vocab consistent
    knife_allies: 'amerknife',
    frag_allies: 'grenade',
    frag_axis: 'grenade2',
};

// weapon: raw logname string -> image src, or null if no sprite exists (caller renders text).
export function getWeaponIcon(weapon) {
    if (!weapon) return null;
    const key = WEAPON_ALIASES[weapon] || weapon;
    return weaponImages[key] || null;
}

export default getWeaponIcon;
