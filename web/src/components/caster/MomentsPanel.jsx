import React, { useMemo } from 'react';

import { useHudStore } from '../core/Socket/Socket';

/*
 * Moments panel — /caster
 *
 * Three things the scoreboard cannot show, each of which is a sentence a caster
 * can say out loud:
 *
 *   SHUTDOWNS   who ended someone's run, and how long that run was
 *   BURSTS      the fastest multi-kill of the half
 *   CAP SETUPS  who cleared the way in the 30s before their team took a flag
 *
 * DELIBERATELY NOT A COMPOSITE SCORE. Krod's accumulation weights ("bounded v3")
 * are unpushed local work — only the shapes are public — so a number invented
 * here would be a third scoring system on air alongside KTPR and accumulation,
 * disagreeing with both. These three facts stand on their own and need no
 * weighting; the composite belongs here only once we can mirror his constants.
 *
 * Reads the `derived` store slice, which is ACCUMULATED as events arrive rather
 * than computed here from `kill_log` — that slice is capped at 150 entries and a
 * long half can exceed it, which would silently turn a half-scoped panel into a
 * moving window. See the constants block in Socket.jsx.
 *
 * Half-scoped, like the rest of the live column: everything here clears with
 * kill_streaks at a half or match boundary.
 */

const TOP_N = 4;

// Whole seconds unless the burst was under ten, where the tenth is the point —
// "three in 2.4s" reads very differently from "three in 2s".
const span = (ms) => {
    const secs = ms / 1000;
    return secs < 10 ? `${secs.toFixed(1)}s` : `${Math.round(secs)}s`;
};

const Row = ({ name, team, value, detail }) => (
    <div className="caster-moment-row">
        <span className={`caster-moment-name caster-${team || 'neutral'}`}>{name}</span>
        <span className="caster-moment-value">{value}</span>
        {detail && <span className="caster-moment-detail">{detail}</span>}
    </div>
);

const Column = ({ title, rows, empty }) => (
    <div className="caster-moment-col">
        <div className="caster-moment-head">{title}</div>
        {rows.length === 0
            ? <p className="caster-idle">{empty}</p>
            : rows.map(r => <Row key={r.key} {...r} />)}
    </div>
);

const MomentsPanel = () => {
    const derived = useHudStore(s => s.derived);
    const alliesPlayers = useHudStore(s => s.allies_players);
    const axisPlayers = useHudStore(s => s.axis_players);

    // Name and side come from the LIVE roster; the store keys everything by
    // user_id so a rename mid-half cannot split a player into two rows.
    const byId = useMemo(() => {
        const m = {};
        [...alliesPlayers, ...axisPlayers].forEach(p => { m[p.user_id] = p; });
        return m;
    }, [alliesPlayers, axisPlayers]);

    const label = (id) => byId[id]?.name ?? id;
    const team = (id) => byId[id]?.team;

    const shutdowns = useMemo(() => Object.entries(derived.shutdowns)
        .sort((a, b) => b[1].count - a[1].count || b[1].best - a[1].best)
        .slice(0, TOP_N)
        .map(([id, v]) => ({
            key: id,
            name: label(id),
            team: team(id),
            value: v.count,
            detail: `best ${v.best}`,
        })), [derived.shutdowns, byId]);

    const bursts = useMemo(() => Object.entries(derived.chains)
        // Most kills first; on a tie the tighter burst is the better one.
        .sort((a, b) => b[1].n - a[1].n || a[1].ms - b[1].ms)
        .slice(0, TOP_N)
        .map(([id, v]) => ({
            key: id,
            name: label(id),
            team: team(id),
            value: v.n,
            detail: `in ${span(v.ms)}`,
        })), [derived.chains, byId]);

    const setups = useMemo(() => Object.entries(derived.cap_setups)
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_N)
        .map(([id, n]) => ({
            key: id,
            name: label(id),
            team: team(id),
            value: n,
        })), [derived.cap_setups, byId]);

    return (
        <section className="caster-panel caster-panel-moments">
            <h2>Moments <span className="caster-count">this half</span></h2>
            <div className="caster-moment-cols">
                <Column title="Shutdowns" rows={shutdowns} empty="No streaks ended yet." />
                <Column title="Bursts" rows={bursts} empty="No multi-kills yet." />
                <Column title="Cap setups" rows={setups} empty="No captures yet." />
            </div>
        </section>
    );
};

export default MomentsPanel;
