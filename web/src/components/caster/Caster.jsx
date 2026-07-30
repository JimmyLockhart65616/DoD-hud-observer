import React, { useEffect, useMemo, useState } from 'react';

import {
    SocketStoreComponent,
    useHudStore,
    statRow,
    addStatRows,
    carrySoFar,
    getHalfRows,
    getRecordedHalves,
} from '../core/Socket/Socket';
import StatsTable from '../core/StatsBoard/StatsTable';
import Flags from '../core/Flags/Flags';
import Timer from '../core/Score/timer/Timer';
import { className as dodClassName } from '../core/dodClasses';
import { getWeaponIcon } from '../screen/resources/weaponIcons';

// Screen.css owns the .stats-board-* table styling and .flag-* strip that this
// page reuses. There's no code splitting, so it's already in the bundle — the
// import documents the dependency and survives a future split. Caster.css comes
// after so its .caster-* overrides win.
import '../screen/Screen.css';
import './Caster.css';

/*
 * Caster reference page — /caster?server=<X-Server-Hostname>
 *
 * The persistent counterpart to the on-air StatsBoard popup: the same full
 * per-player table, but up the whole match on a caster's second monitor, with
 * sorting, a half/match scope toggle, and a freeze control for reading numbers
 * out loud while the game moves.
 *
 * Broadcast-synced, NOT real-time. It joins the same delayed `server:<host>`
 * socket room as /screen (the ~60s HLTV delay is applied backend-side before any
 * emit), so the numbers here match the video the casters and viewers are seeing.
 *
 * Read-only. No backend changes, no new endpoints, no writes to the game.
 */

const SCOPE_LIVE = 'live';
const SCOPE_MATCH = 'match';

const halfLabel = (h) => (h >= 101 ? `OT${h - 100}` : `H${h}`);

// The rows to render for the selected scope.
//   live  — the current in-progress half, straight off the live store
//   match — every completed half folded together with the live half
//   <n>   — one completed half from the carry archive
// Halves are stored per-half rather than eagerly summed, so a scope switch is a
// pure read; nothing here mutates the carry state the on-air board depends on.
function rowsForScope(scope, liveRows) {
    if (scope === SCOPE_LIVE) return liveRows;

    if (scope === SCOPE_MATCH) {
        // Fold prior halves, then add the half in progress. Because teams swap
        // sides at halftime and addStatRows keeps the LATEST team, each player
        // lands under their CURRENT-half side — the same grouping the on-air
        // match_end board uses. Correct for 6v6 with fixed rosters: the two
        // columns are the two rosters as currently sided, not "who was Allies".
        const merged = { ...carrySoFar() };
        liveRows.forEach(r => {
            merged[r.user_id] = merged[r.user_id] ? addStatRows(merged[r.user_id], r) : r;
        });
        return Object.values(merged);
    }

    return Object.values(getHalfRows(Number(scope)) ?? {});
}

const ScopeBar = ({ scope, setScope, half, recordedHalves, carryMissing }) => (
    <div className="caster-scope">
        <button
            className={`caster-chip${scope === SCOPE_LIVE ? ' caster-chip-on' : ''}`}
            onClick={() => setScope(SCOPE_LIVE)}
        >
            {half != null ? `${halfLabel(half)} (LIVE)` : 'THIS HALF'}
        </button>

        {recordedHalves.map(h => (
            <button
                key={h}
                className={`caster-chip${scope === String(h) ? ' caster-chip-on' : ''}`}
                onClick={() => setScope(String(h))}
            >
                {halfLabel(h)}
            </button>
        ))}

        <button
            className={`caster-chip${scope === SCOPE_MATCH ? ' caster-chip-on' : ''}`}
            onClick={() => setScope(SCOPE_MATCH)}
            disabled={recordedHalves.length === 0}
            title={recordedHalves.length === 0
                ? 'No completed half recorded yet — same as the live half'
                : 'All halves combined'}
        >
            MATCH
        </button>

        {carryMissing && (
            <span
                className="caster-warn"
                title="This page loaded after halftime, so half-1 stats were never seen. Reopening won't recover them — the backend evicts the halftime summary once half 2 goes live."
            >
                ⚠ opened after halftime — MATCH totals incomplete
            </span>
        )}
    </div>
);

// Context the table can't show. ALIVE and ON A RUN are always "right now" — a
// current streak has no meaning in a completed half. The leaders, though, follow
// the SELECTED scope (`rows`), so a caster reading "top damage" off this strip
// can't quote a half-scoped number while looking at a match-scoped table.
const TalkingPoints = ({ rows, scopeLabel, alliesPlayers, axisPlayers, killStreaks }) => {
    const hot = Object.entries(killStreaks)
        .filter(([, n]) => n >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);

    const byId = {};
    [...alliesPlayers, ...axisPlayers].forEach(p => { byId[p.user_id] = p; });

    const topDamage = [...rows].sort((a, b) => (b.damage ?? 0) - (a.damage ?? 0))[0];
    const topStreak = [...rows].sort((a, b) => (b.best_streak ?? 0) - (a.best_streak ?? 0))[0];

    const alliesAlive = alliesPlayers.filter(p => !p.dead).length;
    const axisAlive = axisPlayers.filter(p => !p.dead).length;

    return (
        <div className="caster-points">
            <span className="caster-point">
                <span className="caster-point-label">ALIVE</span>
                <span className="caster-allies">{alliesAlive}</span>
                <span className="caster-vs">v</span>
                <span className="caster-axis">{axisAlive}</span>
            </span>

            {hot.length > 0 && (
                <span className="caster-point">
                    <span className="caster-point-label">ON A RUN</span>
                    {hot.map(([id, n]) => (
                        <span key={id} className={`caster-hot caster-${byId[id]?.team ?? 'neutral'}`}>
                            {byId[id]?.name ?? id} <b>{n}</b>
                        </span>
                    ))}
                </span>
            )}

            {(topDamage?.damage ?? 0) > 0 && (
                <span className="caster-point">
                    <span className="caster-point-label">TOP DMG {scopeLabel}</span>
                    <span className={`caster-${topDamage.team}`}>{topDamage.name}</span>
                    <b className="caster-dmg">{topDamage.damage}</b>
                </span>
            )}

            {(topStreak?.best_streak ?? 0) > 0 && (
                <span className="caster-point">
                    <span className="caster-point-label">BEST STREAK {scopeLabel}</span>
                    <span className={`caster-${topStreak.team}`}>{topStreak.name}</span>
                    <b>{topStreak.best_streak}</b>
                </span>
            )}
        </div>
    );
};

// Who's playing what, right now — the table is stats-only and casters ask
// "what's he holding?" constantly.
const Loadouts = ({ players, team }) => (
    <div className={`caster-loadouts caster-loadouts-${team}`}>
        {players.map(p => {
            const icon = p.weapon_primary ? getWeaponIcon(p.weapon_primary) : null;
            return (
                <div key={p.user_id} className={`caster-loadout${p.dead ? ' caster-dead' : ''}`}>
                    <span className="caster-loadout-name">{p.name}</span>
                    <span className="caster-loadout-class">{dodClassName(p.team, p.class_id) || '—'}</span>
                    <span className="caster-loadout-weapon">
                        {icon
                            ? <img src={icon} alt={p.weapon_primary} />
                            : (p.weapon_primary || '')}
                    </span>
                </div>
            );
        })}
    </div>
);

const pad2 = (n) => String(n).padStart(2, '0');

// One kill-feed line. Entries come from the store's kill_log, which carries the
// resolved `killer`/`victim`/`assisters` player objects the overlay's Kill
// component uses (Socket.jsx resolves them against the roster + the persistent
// player directory), plus `streak` and the `addedAt` receipt timestamp.
const KillRow = ({ k }) => {
    const icon = getWeaponIcon(k.weapon);
    const t = new Date(k.addedAt);
    const clock = `${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`;
    const killerName = k.killer?.name ?? k.killer_id;
    const victimName = k.victim?.name ?? k.victim_id;
    return (
        <div className={`caster-kill caster-kill-${k.kill_type}`}>
            <span className="caster-kill-time">{clock}</span>
            <span className={`caster-kill-killer caster-${k.killer?.team ?? 'neutral'}`}>{killerName}</span>
            <span className="caster-kill-weapon">
                {icon ? <img src={icon} alt={k.weapon} /> : k.weapon}
            </span>
            <span className={`caster-kill-victim caster-${k.victim?.team ?? 'neutral'}`}>{victimName}</span>
            <span className="caster-kill-tags">
                {k.headshot && <span className="caster-tag caster-tag-hs" title="headshot">HS</span>}
                {k.victim_prone && <span className="caster-tag caster-tag-prone" title="victim was prone">PRONE</span>}
                {k.kill_type === 'teamkill' && <span className="caster-tag caster-tag-tk">TK</span>}
                {k.kill_type === 'suicide' && <span className="caster-tag caster-tag-tk">SUICIDE</span>}
                {(k.streak ?? 0) >= 3 && <span className="caster-tag caster-tag-streak">{k.streak}x</span>}
                {(k.assisters?.length ?? 0) > 0 && (
                    <span className="caster-tag caster-tag-assist" title="assists — 50+ damage to this victim">
                        +{k.assisters.map(a => a.name).join(', ')}
                    </span>
                )}
            </span>
        </div>
    );
};

function Caster() {
    const urlParams = new URLSearchParams(window.location.search);
    const serverName = urlParams.get('server');

    const alliesPlayers = useHudStore(s => s.allies_players);
    const axisPlayers = useHudStore(s => s.axis_players);
    const alliesScore = useHudStore(s => s.allies_score);
    const axisScore = useHudStore(s => s.axis_score);
    const half = useHudStore(s => s.half);
    const flags = useHudStore(s => s.flags);
    const timeleft = useHudStore(s => s.timeleft);
    const timeleftAt = useHudStore(s => s.timeleft_at);
    const roundState = useHudStore(s => s.round_state);
    const killStreaks = useHudStore(s => s.kill_streaks);
    const killLog = useHudStore(s => s.kill_log);

    const [scope, setScope] = useState(SCOPE_LIVE);
    const [sortKey, setSortKey] = useState('damage');
    const [sortDir, setSortDir] = useState('desc');
    const [frozen, setFrozen] = useState(false);
    const [frozenRows, setFrozenRows] = useState(null);

    // The carry archive (halfRows) is module-level and NOT reactive — a completed
    // half landing there fires no store update. This 1s tick is what makes the
    // scope bar notice, and it doubles as the freeze-banner heartbeat. Same
    // pattern StatsBoard uses for its render-time TTL. 12 players and a couple
    // of folds per second is free; mirroring the carry into the store instead
    // would put the on-air cumulative-stats state machine on the render path.
    const [, setTick] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setTick(n => n + 1), 1000);
        return () => clearInterval(id);
    }, []);

    const liveRows = useMemo(
        () => [...alliesPlayers, ...axisPlayers].map(statRow),
        [alliesPlayers, axisPlayers],
    );

    const recordedHalves = getRecordedHalves();
    // Half 2+ with nothing archived means this page loaded after the boundary:
    // the backend's join snapshot replays the cached halftime summary only until
    // half_start evicts it, so half-1 stats are simply unavailable to us.
    const carryMissing = (half ?? 1) >= 2 && recordedHalves.length === 0;

    const computedRows = rowsForScope(scope, liveRows);

    // Freeze snapshots the rows so a caster can read a stable table mid-firefight.
    // The socket keeps running underneath; unfreezing jumps to current.
    const rows = frozen && frozenRows ? frozenRows : computedRows;
    const toggleFreeze = () => {
        if (frozen) { setFrozen(false); setFrozenRows(null); }
        else { setFrozenRows(computedRows); setFrozen(true); }
    };

    // Short scope tag for the talking-points labels, so "TOP DMG" always says
    // which window it's measuring.
    const scopeLabel = scope === SCOPE_MATCH ? 'MATCH'
        : scope === SCOPE_LIVE ? (half != null ? halfLabel(half) : '')
        : halfLabel(Number(scope));

    const onSort = (key) => {
        if (key === sortKey) { setSortDir(d => (d === 'desc' ? 'asc' : 'desc')); }
        else { setSortKey(key); setSortDir('desc'); }
    };

    if (!serverName) {
        return (
            <div className="caster-page caster-empty">
                <h1>Caster Stats</h1>
                <p>
                    No server selected. Open this page as
                    {' '}<code>/caster?server=&lt;server hostname&gt;</code>, or pick one from{' '}
                    <a href="/watch">the match picker</a>.
                </p>
            </div>
        );
    }

    return (
        <div className="caster-page">
            <SocketStoreComponent />

            <header className="caster-header">
                <div className="caster-scoreline">
                    <span className="caster-team caster-allies">ALLIES</span>
                    <span className="caster-score">{alliesScore}</span>
                    <span className="caster-clock">
                        <Timer
                            timeleft={timeleft}
                            timeleftAt={timeleftAt}
                            frozen={roundState.round_freeze || roundState.round_end}
                        />
                    </span>
                    <span className="caster-score">{axisScore}</span>
                    <span className="caster-team caster-axis">AXIS</span>
                </div>
                <div className="caster-meta">
                    <span className="caster-half">{half != null ? halfLabel(half) : '—'}</span>
                    <span className="caster-server">{serverName}</span>
                    <span className="caster-delay" title="This page is synced to the HLTV broadcast, matching the stream — not the live server.">
                        broadcast-synced
                    </span>
                </div>
            </header>

            {flags.length > 0 && (
                <div className="caster-flags">
                    <Flags flags={flags} />
                </div>
            )}

            <TalkingPoints
                rows={rows}
                scopeLabel={scopeLabel}
                alliesPlayers={alliesPlayers}
                axisPlayers={axisPlayers}
                killStreaks={killStreaks}
            />

            <div className="caster-toolbar">
                <ScopeBar
                    scope={scope}
                    setScope={setScope}
                    half={half}
                    recordedHalves={recordedHalves}
                    carryMissing={carryMissing}
                />
                <button
                    className={`caster-chip caster-freeze${frozen ? ' caster-chip-frozen' : ''}`}
                    onClick={toggleFreeze}
                    title="Hold the table still while you read it — the feed keeps running underneath"
                >
                    {frozen ? '▶ RESUME' : '❄ FREEZE'}
                </button>
            </div>

            {frozen && (
                <div className="caster-frozen-banner">
                    FROZEN — table is a snapshot, not live
                </div>
            )}

            <div className="caster-tables stats-board-teams">
                <StatsTable team="allies" players={rows} sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <StatsTable team="axis" players={rows} sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            </div>

            {rows.length === 0 && (
                <p className="caster-idle">
                    Waiting for events from <code>{serverName}</code>…
                </p>
            )}

            <div className="caster-lower">
                <section className="caster-panel">
                    <h2>Loadouts</h2>
                    <div className="caster-loadout-cols">
                        <Loadouts players={alliesPlayers} team="allies" />
                        <Loadouts players={axisPlayers} team="axis" />
                    </div>
                </section>

                <section className="caster-panel caster-panel-feed">
                    <h2>Kill Feed <span className="caster-count">{killLog.length}</span></h2>
                    <div className="caster-feed">
                        {killLog.length === 0
                            ? <p className="caster-idle">No kills yet this half.</p>
                            : [...killLog].reverse().map(k => <KillRow key={k.id} k={k} />)}
                    </div>
                </section>
            </div>
        </div>
    );
}

export default Caster;
