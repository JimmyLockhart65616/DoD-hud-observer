import React, { useEffect, useState } from 'react';
import { getWeaponIcon } from '../../screen/resources/weaponIcons';

// Centered stats board — full per-player stat table shown on a full capout,
// at halftime, at match end, or on rcon amx_hud_statsboard. Driven by the
// store's stats_board ({ reason, fallback, players, addedAt }); visibility is
// render-time TTL by reason (never setTimeout — OBS background throttling),
// plus explicit dismissal when the next half goes live (handled in Socket.jsx).

const TITLES = {
    half_end:  'HALFTIME STATS',
    match_end: 'FINAL STATS',
    manual:    'STATS',
};

// Capout board titles by who swept the last flag, e.g. "ALLIES CAPOUT BY mogers".
// Falls back to a plain team capout, then a generic label.
function boardTitle(board) {
    if (board.reason === 'round_end') {
        const team = (board.capout_team || '').toUpperCase();
        if (team && board.capout_by) return `${team} CAPOUT BY ${board.capout_by}`;
        if (team) return `${team} CAPOUT`;
        return 'CAPOUT';
    }
    return TITLES[board.reason] ?? 'STATS';
}

const hsPct = (kills, hs) => ((kills ?? 0) > 0 ? Math.round((100 * (hs ?? 0)) / kills) : 0);

// Aggregate a team's rows into a totals line. Additive fields sum; HS% is the
// team-wide ratio; streak is the team's single best.
function teamTotals(rows) {
    return rows.reduce((t, p) => ({
        kills: t.kills + (p.kills ?? 0),
        deaths: t.deaths + (p.deaths ?? 0),
        assists: t.assists + (p.assists ?? 0),
        damage: t.damage + (p.damage ?? 0),
        hs_kills: t.hs_kills + (p.hs_kills ?? 0),
        nade_kills: t.nade_kills + (p.nade_kills ?? 0),
        caps: t.caps + (p.caps ?? 0),
        best_streak: Math.max(t.best_streak, p.best_streak ?? 0),
    }), { kills: 0, deaths: 0, assists: 0, damage: 0, hs_kills: 0, nade_kills: 0, caps: 0, best_streak: 0 });
}

const TeamTable = ({ team, players }) => {
    const rows = players
        .filter(p => p.team === team)
        .sort((a, b) => (b.damage ?? 0) - (a.damage ?? 0));
    if (rows.length === 0) return null;

    const nadeIcon = getWeaponIcon(team === 'axis' ? 'grenade2' : 'grenade');
    // MVP = top damage on the team (only if they actually did something).
    const mvpId = (rows[0]?.damage ?? 0) > 0 ? rows[0].user_id : null;
    const tot = teamTotals(rows);

    return (
        <div className={`stats-board-team stats-board-${team}`}>
            <div className="stats-board-team-name">{team === 'allies' ? 'ALLIES' : 'AXIS'}</div>
            <table className="stats-board-table">
                <thead>
                    <tr>
                        <th className="stats-board-player-col">PLAYER</th>
                        <th>K</th>
                        <th>D</th>
                        <th>A</th>
                        <th>DMG</th>
                        <th title="headshot kill %">HS%</th>
                        <th title="grenade kills">
                            {nadeIcon ? <img className="stats-board-nade-icon" src={nadeIcon} alt="nade kills" /> : 'NK'}
                        </th>
                        <th title="flag caps">CAP</th>
                        <th title="best kill streak this half">STK</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map(p => (
                        <tr key={p.user_id} className={p.user_id === mvpId ? 'stats-board-mvp' : ''}>
                            <td className="stats-board-player-col">
                                {p.user_id === mvpId && <span className="stats-board-mvp-tag">MVP</span>}
                                {p.name}
                            </td>
                            <td>{p.kills ?? 0}</td>
                            <td>{p.deaths ?? 0}</td>
                            <td>{p.assists ?? 0}</td>
                            <td className="stats-board-dmg">{p.damage ?? 0}</td>
                            <td>{hsPct(p.kills, p.hs_kills)}</td>
                            <td>{p.nade_kills ?? 0}</td>
                            <td>{p.caps ?? 0}</td>
                            <td>{p.best_streak ?? 0}</td>
                        </tr>
                    ))}
                </tbody>
                <tfoot>
                    <tr className="stats-board-totals">
                        <td className="stats-board-player-col">TEAM</td>
                        <td>{tot.kills}</td>
                        <td>{tot.deaths}</td>
                        <td>{tot.assists}</td>
                        <td className="stats-board-dmg">{tot.damage}</td>
                        <td>{hsPct(tot.kills, tot.hs_kills)}</td>
                        <td>{tot.nade_kills}</td>
                        <td>{tot.caps}</td>
                        <td>{tot.best_streak}</td>
                    </tr>
                </tfoot>
            </table>
        </div>
    );
};

const StatsBoard = React.memo(({ board, settings }) => {
    const [now, setNow] = useState(() => Date.now());

    // 1s ticker only while a board is up, so it can age out.
    useEffect(() => {
        if (!board) return undefined;
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, [board]);

    if (!board) return null;
    if (board.reason === 'round_end' && settings.stats_board_on_round_end === false) return null;

    const ttl = board.reason === 'round_end' ? (settings.statsboard_round_displaytime ?? 12000)
        : board.fallback ? (settings.statsboard_fallback_displaytime ?? 20000)
        : (settings.statsboard_half_displaytime ?? 90000);
    if (now - (board.addedAt ?? 0) > ttl) return null;

    return (
        <div className={`stats-board stats-board-reason-${board.reason}`}>
            {/* No team-score line — the top score bar already shows it. */}
            <div className="stats-board-title">{boardTitle(board)}</div>
            <div className="stats-board-teams">
                <TeamTable team="allies" players={board.players} />
                <TeamTable team="axis" players={board.players} />
            </div>
        </div>
    );
});

export default StatsBoard;
