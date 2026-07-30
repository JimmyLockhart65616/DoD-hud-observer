import React, { useEffect, useState } from 'react';
import StatsTable from './StatsTable';

// Centered stats board — full per-player stat table shown on a full capout,
// at halftime, at match end, or on rcon amx_hud_statsboard. Driven by the
// store's stats_board ({ reason, fallback, players, addedAt }); visibility is
// render-time TTL by reason (never setTimeout — OBS background throttling),
// plus explicit dismissal when the next half goes live (handled in Socket.jsx).
//
// The table itself lives in StatsTable.jsx, shared with the persistent caster
// page (/caster). This board owns only the popup behavior: title, TTL, backdrop.

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

    // TTL is a render-time backstop. half_end/match_end boards are normally
    // dismissed explicitly by the next half/match going live (handleHalfBoundary
    // in Socket.jsx); the half_end TTL is set long enough to span the whole
    // intermission warmup so the board covers the DoD scoreboard until half-2
    // actually goes live. match_end keeps its own shorter window. The capout
    // (round_end) and snapshot-fallback boards are short, self-expiring popups.
    const ttl = board.reason === 'round_end' ? (settings.statsboard_round_displaytime ?? 12000)
        : board.fallback ? (settings.statsboard_fallback_displaytime ?? 20000)
        : board.reason === 'match_end' ? (settings.statsboard_match_displaytime ?? 90000)
        : (settings.statsboard_half_displaytime ?? 90000);
    if (now - (board.addedAt ?? 0) > ttl) return null;

    // Intermission boards (halftime / match end) fully cover the game's default
    // DoD scoreboard with an opaque backdrop. Capouts stay a floating panel so
    // the live game still shows through mid-half.
    const fullCover = board.reason === 'half_end' || board.reason === 'match_end';

    return (
        <>
            {fullCover && <div className="stats-board-backdrop" />}
            <div className={`stats-board stats-board-reason-${board.reason}`}>
                {/* No team-score line — the top score bar already shows it. */}
                <div className="stats-board-title">{boardTitle(board)}</div>
                <div className="stats-board-teams">
                    <StatsTable team="allies" players={board.players} />
                    <StatsTable team="axis" players={board.players} />
                </div>
            </div>
        </>
    );
});

export default StatsBoard;
