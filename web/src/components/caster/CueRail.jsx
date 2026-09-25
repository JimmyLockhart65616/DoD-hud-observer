import React, { useEffect, useMemo, useRef, useState } from 'react';

import { useHudStore } from '../core/Socket/Socket';
import { humanizeFlagName } from '../core/Flags/humanize';
import { pAlliesFromSnapshot, detectSwing, MOMENTUM_WINDOW_MS, MOMENTUM_COOLDOWN_MS } from './momentum';

/*
 * Cue rail — /caster
 *
 * A scrolling feed of "have the camera ready" moments, computed client-side
 * from state this page already holds — no new socket subscription, no
 * backend change (same read-only contract as the rest of /caster).
 *
 * Three of the four cue kinds are LEADING, not recap: they fire before the
 * payoff, same as a caster would call it themselves —
 *
 *   RUN          a player's kill_streaks entry reaches 2 — the third kill,
 *                if it comes, is usually seconds away (see fast_multikills
 *                in the match report: median gap under 10s).
 *   CAP THREAT   a flag_cap in progress that would, if it completes, either
 *                sweep the board or leave the other team defending their
 *                last flag. Named by captor_ids, so the cue points the
 *                camera at the actual player mid-capture.
 *   SWING        flagswing's p_allies (see momentum.js — vendored from
 *                KTPInfrastructure/scripts/flagswing) has moved past
 *                MOMENTUM_THRESHOLD within MOMENTUM_WINDOW_MS. No single
 *                player to name — this is "something is shifting", the cue
 *                to widen out rather than stay tight on one duel.
 *   CAP-OUT      recap, not leading — stats_board's round_end reason, fired
 *                the instant the board itself would show it. Kept on the
 *                rail (stats_board clears fast, on the very next round) so
 *                it doesn't vanish before a caster can read it.
 *
 * Each cue expires and drops off the rail once its moment has passed —
 * ruled by drew (2026-09-25): scrolling, not a fixed list.
 */

const CAPOUT_DISPLAY_MS = 15000;
const SWING_DISPLAY_MS = 15000;
// A streak this stale is not "building" any more — the round moved on
// without a kill_streaks reset reaching us (map change, a missed event).
const RUN_STALE_MS = 45000;

const byId = (alliesPlayers, axisPlayers) => {
    const m = {};
    [...alliesPlayers, ...axisPlayers].forEach(p => { m[p.user_id] = p; });
    return m;
};

// Would completing THIS capture sweep the board, or leave the other side
// defending their last flag? Both are the high-stakes cases worth a cue;
// an ordinary flag change on a 5-flag map with plenty left is not.
export function threatKind(flags, flagId, cappingTeam) {
    const total = flags.length;
    if (total === 0) return null;
    let mine = 0;
    flags.forEach(f => {
        const owner = f.flag_id === flagId ? cappingTeam : f.owner;
        if (owner === cappingTeam) mine += 1;
    });
    if (mine === total) return 'sweep';
    if (total - mine === 1) return 'last_flag';
    return null;
}

const Cue = ({ c }) => {
    if (c.kind === 'run') {
        return (
            <div className="caster-cue caster-cue-run">
                <span className="caster-tag caster-tag-run">RUN</span>
                <span className={`caster-cue-who caster-${c.team || 'neutral'}`}>{c.name}</span>
                <span className="caster-cue-detail">{c.streak} straight — stay on them</span>
            </div>
        );
    }
    if (c.kind === 'cap_threat') {
        return (
            <div className="caster-cue caster-cue-threat">
                <span className="caster-tag caster-tag-threat">CAP THREAT</span>
                <span className={`caster-cue-who caster-${c.team}`}>{c.captorNames.join(', ')}</span>
                <span className="caster-cue-detail">
                    taking <b>{c.flagName}</b> — {c.threat === 'sweep' ? 'would sweep the board' : "would leave the other side one flag from empty"}
                </span>
            </div>
        );
    }
    if (c.kind === 'swing') {
        return (
            <div className="caster-cue caster-cue-swing">
                <span className="caster-tag caster-tag-swing">SWING</span>
                <span className={`caster-cue-who caster-${c.team}`}>{c.team === 'allies' ? 'ALLIES' : 'AXIS'}</span>
                <span className="caster-cue-detail">momentum moving their way — widen out</span>
            </div>
        );
    }
    // capout
    return (
        <div className="caster-cue caster-cue-capout">
            <span className="caster-tag caster-tag-capout">CAP-OUT</span>
            <span className={`caster-cue-who caster-${c.team}`}>{c.by}</span>
            <span className="caster-cue-detail">closed it out</span>
        </div>
    );
};

const CueRail = () => {
    const killStreaks = useHudStore(s => s.kill_streaks);
    const flags = useHudStore(s => s.flags);
    const statsBoard = useHudStore(s => s.stats_board);
    const alliesPlayers = useHudStore(s => s.allies_players);
    const axisPlayers = useHudStore(s => s.axis_players);

    const [cues, setCues] = useState([]);
    // Re-render on a tick so a cue's own expiry (run-staleness, capout
    // display window) is re-evaluated even with no new store event — the
    // same pattern the scope bar uses to notice the un-reactive carry.
    const [, setTick] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setTick(n => n + 1), 1000);
        return () => clearInterval(id);
    }, []);

    const players = useMemo(() => byId(alliesPlayers, axisPlayers), [alliesPlayers, axisPlayers]);

    // ── RUN: kill_streaks >= 2, dropped when it falls back below 2 ──────────
    useEffect(() => {
        const now = Date.now();
        setCues(prev => {
            const withoutStaleRuns = prev.filter(c => c.kind !== 'run' ||
                (killStreaks[c.userId] ?? 0) >= 2);
            const existing = new Set(withoutStaleRuns.filter(c => c.kind === 'run').map(c => c.userId));
            const additions = Object.entries(killStreaks)
                .filter(([id, n]) => n >= 2 && !existing.has(id))
                .map(([id, n]) => ({
                    key: `run-${id}`,
                    kind: 'run',
                    userId: id,
                    name: players[id]?.name ?? id,
                    team: players[id]?.team,
                    streak: n,
                    firedAt: now,
                }));
            // Keep an already-listed run's streak number current without
            // moving it in the rail — only a NEW run re-enters at the top.
            const refreshed = withoutStaleRuns.map(c =>
                c.kind === 'run' && killStreaks[c.userId] > c.streak
                    ? { ...c, streak: killStreaks[c.userId] }
                    : c);
            return additions.length ? [...additions, ...refreshed] : refreshed;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [killStreaks, players]);

    // ── CAP THREAT: a flag_cap in progress that would sweep or leave a last
    // flag, dropped the instant that flag stops capping (captured or broken up) ──
    useEffect(() => {
        const now = Date.now();
        setCues(prev => {
            const inProgressIds = new Set(
                flags.filter(f => f.capping_team).map(f => f.flag_id));
            const withoutStopped = prev.filter(c =>
                c.kind !== 'cap_threat' || inProgressIds.has(c.flagId));
            const existing = new Set(withoutStopped.filter(c => c.kind === 'cap_threat').map(c => c.flagId));
            const additions = [];
            flags.forEach(f => {
                if (!f.capping_team || existing.has(f.flag_id)) return;
                const threat = threatKind(flags, f.flag_id, f.capping_team);
                if (!threat) return;
                const captorNames = (f.captor_ids || []).map(id => players[id]?.name ?? id);
                additions.push({
                    key: `capthreat-${f.flag_id}-${now}`,
                    kind: 'cap_threat',
                    flagId: f.flag_id,
                    flagName: humanizeFlagName(f.flag_name),
                    team: f.capping_team,
                    captorNames: captorNames.length ? captorNames : ['unknown'],
                    threat,
                    firedAt: now,
                });
            });
            return additions.length ? [...additions, ...withoutStopped] : withoutStopped;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [flags, players]);

    // ── SWING: p_allies moved past threshold inside the trailing window ─────
    const swingHistory = useRef([]);
    const lastSwingAt = useRef(0);
    const half = useHudStore(s => s.half);
    useEffect(() => {
        // A half boundary swaps sides and resets flags/lives — the history
        // would otherwise read a fresh half as a giant swing off the last
        // half's final state.
        swingHistory.current = [];
        lastSwingAt.current = 0;
    }, [half]);
    useEffect(() => {
        const now = Date.now();
        const p = pAlliesFromSnapshot({ alliesPlayers, axisPlayers, flags });
        const history = [...swingHistory.current, { t: now, v: p }]
            .filter(r => now - r.t <= MOMENTUM_WINDOW_MS);
        swingHistory.current = history;

        if (now - lastSwingAt.current < MOMENTUM_COOLDOWN_MS) return;
        const swing = detectSwing(history);
        if (!swing) return;
        lastSwingAt.current = now;
        setCues(prev => [{
            key: `swing-${now}`,
            kind: 'swing',
            team: swing.team,
            firedAt: now,
        }, ...prev]);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [alliesPlayers, axisPlayers, flags]);

    // ── CAP-OUT: one shot per stats_board round_end, self-expiring ──────────
    const lastCapoutAt = useRef(null);
    useEffect(() => {
        if (statsBoard?.reason !== 'round_end' || !statsBoard.capout_team) return;
        if (lastCapoutAt.current === statsBoard.addedAt) return;
        lastCapoutAt.current = statsBoard.addedAt;
        setCues(prev => [{
            key: `capout-${statsBoard.addedAt}`,
            kind: 'capout',
            team: statsBoard.capout_team,
            by: statsBoard.capout_by || 'the team',
            firedAt: statsBoard.addedAt,
        }, ...prev]);
    }, [statsBoard]);

    // ── Expiry sweep: capouts age out on a timer, runs age out if stale ─────
    const visible = useMemo(() => {
        const now = Date.now();
        return cues.filter(c => {
            if (c.kind === 'capout') return now - c.firedAt < CAPOUT_DISPLAY_MS;
            if (c.kind === 'swing') return now - c.firedAt < SWING_DISPLAY_MS;
            if (c.kind === 'run') return now - c.firedAt < RUN_STALE_MS;
            return true; // cap_threat is dropped by the effect above, not time
        });
    }, [cues]);

    return (
        <section className="caster-panel caster-panel-cues">
            <h2>Cue Rail <span className="caster-count">have the camera ready</span></h2>
            <div className="caster-cues">
                {visible.length === 0
                    ? <p className="caster-idle">Nothing building right now.</p>
                    : visible.map(c => <Cue key={c.key} c={c} />)}
            </div>
        </section>
    );
};

export default CueRail;
