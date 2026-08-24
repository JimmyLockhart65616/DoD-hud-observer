import React, { useMemo } from 'react';

import { useCareerStats } from './useCareerStats';

/*
 * Career panel — /caster
 *
 * The first surface in this repo that reads the LEAGUE STATS DATABASE
 * (KTPHLStatsX / MySQL `hlstatsx`) rather than the live socket feed. Everything
 * else on this page is the current match; this is the players' history, which is
 * exactly the context a caster reaches for between rounds ("he's on 40 league
 * matches and has never had a half like this").
 *
 * Two properties worth keeping if this is extended:
 *
 *  - IT MUST DISAPPEAR WHEN THE DATABASE IS OFF. `stats_db.enabled` is false by
 *    default — including in production until a read-only MySQL user exists — and
 *    a permanently empty panel on a caster's second monitor reads as a broken
 *    page. `useCareerStats` reports 'unavailable' for both "not configured" and
 *    "shedding load", and this renders nothing at all for it.
 *  - IT MUST NOT DRIVE THE BROADCAST PATH. These numbers are historical and are
 *    fetched at most every 5 minutes. Nothing here belongs on /screen: an on-air
 *    overlay that depends on a MySQL query is an on-air overlay that goes blank
 *    when the data server is busy.
 *
 * Rows are labelled from the LIVE roster and joined to the database on SteamID,
 * so a player who has since changed their in-game name still matches.
 */

const ratio = (k, d) => (d > 0 ? (k / d).toFixed(2) : k > 0 ? k.toFixed(2) : '0.00');
const pct = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—');

const CareerRow = ({ player, career }) => {
    // Absent from the result is not zero: it means no league match has ever been
    // recorded for this SteamID. A debutant and a player who went 0-and-40 are
    // different stories and a caster should not have to guess which they're
    // looking at.
    if (!career) {
        return (
            <div className="caster-career-row caster-career-new">
                <span className="caster-career-name">{player.name}</span>
                <span className="caster-career-note">no league record</span>
            </div>
        );
    }

    return (
        <div className="caster-career-row">
            <span className="caster-career-name">{player.name}</span>
            <span className="caster-career-stat">{career.matches}</span>
            <span className="caster-career-stat caster-career-kd">{ratio(career.kills, career.deaths)}</span>
            <span className="caster-career-stat">{pct(career.headshots, career.kills)}</span>
        </div>
    );
};

const CareerColumn = ({ players, careers, team }) => (
    <div className={`caster-career-col caster-career-${team}`}>
        <div className="caster-career-row caster-career-head">
            <span className="caster-career-name">{team === 'allies' ? 'Allies' : 'Axis'}</span>
            <span className="caster-career-stat">M</span>
            <span className="caster-career-stat">K/D</span>
            <span className="caster-career-stat">HS</span>
        </div>
        {players.map(p => (
            <CareerRow key={p.user_id} player={p} career={careers[p.user_id]} />
        ))}
    </div>
);

const CareerPanel = ({ alliesPlayers, axisPlayers }) => {
    const roster = useMemo(
        () => [...alliesPlayers, ...axisPlayers],
        [alliesPlayers, axisPlayers],
    );
    const ids = useMemo(() => roster.map(p => p.user_id), [roster]);

    const { careers, status } = useCareerStats(ids);

    // Switched off (or shedding). Render nothing — see the header comment.
    if (status === 'unavailable') return null;
    if (!roster.length) return null;

    return (
        <section className="caster-panel caster-panel-career">
            <h2>
                League Career
                {status === 'loading' && <span className="caster-count">…</span>}
                {status === 'error' && <span className="caster-count caster-career-warn">unreachable</span>}
            </h2>
            <div className="caster-career-cols">
                <CareerColumn players={alliesPlayers} careers={careers} team="allies" />
                <CareerColumn players={axisPlayers} careers={careers} team="axis" />
            </div>
        </section>
    );
};

export default CareerPanel;
