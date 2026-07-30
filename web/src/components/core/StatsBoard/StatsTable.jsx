import React from 'react';
import { getWeaponIcon } from '../../screen/resources/weaponIcons';

// One team's per-player stat table. Extracted from StatsBoard so the transient
// on-air board and the persistent caster page (/caster) render the same table
// from one source of truth.
//
// sortKey/sortDir default to damage-desc — the behavior the broadcast overlay
// has always had — so <StatsTable team players /> is DOM-identical to the old
// inline TeamTable. Only the caster page passes them.

export const hsPct = (kills, hs) => ((kills ?? 0) > 0 ? Math.round((100 * (hs ?? 0)) / kills) : 0);

// Aggregate a team's rows into a totals line. Additive fields sum; HS% is the
// team-wide ratio; streak is the team's single best.
export function teamTotals(rows) {
    return rows.reduce((t, p) => ({
        kills: t.kills + (p.kills ?? 0),
        deaths: t.deaths + (p.deaths ?? 0),
        assists: t.assists + (p.assists ?? 0),
        damage: t.damage + (p.damage ?? 0),
        hs_kills: t.hs_kills + (p.hs_kills ?? 0),
        nade_kills: t.nade_kills + (p.nade_kills ?? 0),
        caps: t.caps + (p.caps ?? 0),
        cap_breaks: t.cap_breaks + (p.cap_breaks ?? 0),
        best_streak: Math.max(t.best_streak, p.best_streak ?? 0),
    }), { kills: 0, deaths: 0, assists: 0, damage: 0, hs_kills: 0, nade_kills: 0, caps: 0, cap_breaks: 0, best_streak: 0 });
}

// Column definitions, shared so the caster page's sort headers can't drift from
// the cells. `value` is both the rendered cell and the sort comparand; hs% sorts
// on the computed ratio, not the raw hs_kills count.
export const STAT_COLUMNS = [
    { key: 'kills',       label: 'K',    title: 'kills',   value: p => p.kills ?? 0 },
    { key: 'deaths',      label: 'D',    title: 'deaths',  value: p => p.deaths ?? 0 },
    { key: 'assists',     label: 'A',    title: 'assists — 50+ damage to a victim killed by someone else', value: p => p.assists ?? 0 },
    { key: 'damage',      label: 'DMG',  title: 'damage dealt', value: p => p.damage ?? 0, cellClass: 'stats-board-dmg' },
    { key: 'hs_pct',      label: 'HS%',  title: 'headshot kill %', value: p => hsPct(p.kills, p.hs_kills) },
    { key: 'nade_kills',  label: 'NK',   title: 'grenade kills', value: p => p.nade_kills ?? 0, icon: true },
    { key: 'caps',        label: 'CAP',  title: 'flag caps', value: p => p.caps ?? 0 },
    { key: 'cap_breaks',  label: 'BRK',  title: 'cap breaks — killed an enemy capper on the point', value: p => p.cap_breaks ?? 0 },
    { key: 'best_streak', label: 'STK',  title: 'best kill streak', value: p => p.best_streak ?? 0 },
];

const StatsTable = ({
    team,
    players,
    sortKey = 'damage',
    sortDir = 'desc',
    onSort,          // caster page only — makes the headers clickable
}) => {
    const col = STAT_COLUMNS.find(c => c.key === sortKey);
    const cmp = col ? col.value : (p => p.damage ?? 0);
    const dir = sortDir === 'asc' ? -1 : 1;

    const rows = players
        .filter(p => p.team === team)
        .sort((a, b) => (cmp(b) - cmp(a)) * dir);
    if (rows.length === 0) return null;

    const nadeIcon = getWeaponIcon(team === 'axis' ? 'grenade2' : 'grenade');
    // MVP = top damage on the team (only if they actually did something). Always
    // damage-based regardless of the active sort — it's an award, not a position.
    const byDamage = [...rows].sort((a, b) => (b.damage ?? 0) - (a.damage ?? 0));
    const mvpId = (byDamage[0]?.damage ?? 0) > 0 ? byDamage[0].user_id : null;
    const tot = teamTotals(rows);

    const header = (c) => {
        const label = c.icon && nadeIcon
            ? <img className="stats-board-nade-icon" src={nadeIcon} alt="nade kills" />
            : c.label;
        if (!onSort) return <th key={c.key} title={c.title}>{label}</th>;
        return (
            <th
                key={c.key}
                title={c.title}
                className={`caster-sortable${sortKey === c.key ? ' caster-sorted' : ''}`}
                onClick={() => onSort(c.key)}
            >
                {label}{sortKey === c.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
            </th>
        );
    };

    return (
        <div className={`stats-board-team stats-board-${team}`}>
            <div className="stats-board-team-name">{team === 'allies' ? 'ALLIES' : 'AXIS'}</div>
            <table className="stats-board-table">
                <thead>
                    <tr>
                        <th className="stats-board-player-col">PLAYER</th>
                        {STAT_COLUMNS.map(header)}
                    </tr>
                </thead>
                <tbody>
                    {rows.map(p => (
                        <tr key={p.user_id} className={p.user_id === mvpId ? 'stats-board-mvp' : ''}>
                            <td className="stats-board-player-col">
                                {p.user_id === mvpId && <span className="stats-board-mvp-tag">MVP</span>}
                                {p.name}
                            </td>
                            {STAT_COLUMNS.map(c => (
                                <td key={c.key} className={c.cellClass}>{c.value(p)}</td>
                            ))}
                        </tr>
                    ))}
                </tbody>
                <tfoot>
                    <tr className="stats-board-totals">
                        <td className="stats-board-player-col">TEAM</td>
                        {STAT_COLUMNS.map(c => (
                            <td key={c.key} className={c.cellClass}>
                                {c.key === 'hs_pct' ? hsPct(tot.kills, tot.hs_kills) : (tot[c.key] ?? 0)}
                            </td>
                        ))}
                    </tr>
                </tfoot>
            </table>
        </div>
    );
};

export default StatsTable;
