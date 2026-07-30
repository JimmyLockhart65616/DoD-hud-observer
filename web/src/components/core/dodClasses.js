// DoD 1.3 class names by class_id, per side. Mirrors the class table in
// CLAUDE.md (Allies 0-5, Axis 0-6 — Axis has the extra MG42 slot). Short display
// forms, sized for a HUD cell rather than the full German rank names.
//
// Shared so the caster page and PlayerObserved can't drift apart.

export const ALLIED_CLASSES = ['Rifleman', 'Staff Sgt', 'Master Sgt', 'LMG', 'Sniper', 'Rocket'];
export const AXIS_CLASSES   = ['Grenadier', 'Stosstruppe', 'Unteroffizier', 'Sturmtruppe', 'Scharfschütze', 'Panzerschreck', 'MG42'];

// '' for an unknown/unset class_id (null while a player is dead — roster_player
// deliberately reports class_id null rather than lying about a stale spawn).
export function className(team, classId) {
    if (classId === null || classId === undefined) return '';
    const table = team === 'axis' ? AXIS_CLASSES : ALLIED_CLASSES;
    return table[classId] || '';
}
