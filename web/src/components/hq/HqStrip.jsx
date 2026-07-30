import React from 'react';
import Timer from '../core/Score/timer/Timer';
import HqRoster from './HqRoster';
import HqFlagStrip from './HqFlagStrip';

const pad2 = n => String(n).padStart(2, '0');

/** "KTP - New York 1" -> "NEW YORK 1"; "KTP LAN 3" -> "LAN 3". */
const shortName = host => host.replace(/^KTP\s*-?\s*/i, '').toUpperCase();

/** half is 1, 2, or 101+ for overtime periods. */
const halfLabel = half => {
    if (half == null) return '—';
    if (half >= 101) return `OT${half - 100}`;
    return `HALF ${half}`;
};

const MATCH_TYPES = ['COMPETITIVE', 'SCRIM', '12MAN', 'DRAFT', 'KTP OT', 'DRAFT OT'];

const STATUS_LABEL = {
    LIVE: 'LIVE',
    WARMUP: 'WARMUP',
    BETWEEN: 'STANDBY',
    STALE: 'REBUILDING',
    NO_SIGNAL: 'NO SIGNAL',
};

/** Shown in place of the rosters when nobody is on the server. */
const EMPTY_MESSAGE = {
    LIVE: 'NO PLAYERS ON TEAMS',
    WARMUP: 'WARMUP — WAITING FOR MATCH START',
    BETWEEN: 'NO MATCH — SERVER IDLE',
    STALE: 'REBUILDING STATE — AWAITING NEXT ROUND EVENT',
    NO_SIGNAL: 'OFFLINE — NO EVENTS RECEIVED',
};

const HqStrip = ({ index, server, anchor }) => {
    const s = server;
    const hasPlayers = s.playerCount > 0;
    const matchType = s.matchType != null ? MATCH_TYPES[s.matchType] : null;

    // Whether this server's cached game state can be trusted as CURRENT.
    //
    // The backend's state cache is never evicted, so a server that drops off
    // keeps reporting its last-known score, clock and flags forever. Rendering
    // those is actively misleading on a board whose whole job is current state —
    // worst of all the clock, which free-runs client-side and would tick down on
    // a machine that has been off for an hour, reading as a live game.
    // (ktp_match_end already nulls the score, but not the flags.)
    const showCurrent = s.status === 'LIVE' || s.status === 'WARMUP';

    return (
        <section className={`hq-strip hq-strip-${s.status.toLowerCase()}`}>
            <div className="hq-rail">
                <div className="hq-designator">{pad2(index)}</div>
                <div className="hq-servername">{shortName(s.hostname)}</div>
                <div className="hq-status">
                    <span className="hq-dot" />
                    <span className="hq-status-text">{STATUS_LABEL[s.status]}</span>
                </div>
            </div>

            <div className="hq-context">
                <div className="hq-map">{s.map || '—'}</div>
                <div className="hq-context-meta">
                    <span>{halfLabel(s.half)}</span>
                    <span className="hq-context-sep">·</span>
                    <span>{s.playerCount} PLR</span>
                </div>
                {matchType && <div className="hq-matchtype">{matchType}</div>}
                {s.delayActive && (
                    <div className="hq-delay" title="This feed is held back to match the HLTV broadcast">
                        ⧗ {s.delaySeconds != null ? `−${Math.round(s.delaySeconds)}s` : 'DELAYED'}
                    </div>
                )}
            </div>

            <div className="hq-scoreblock">
                <div className="hq-scores">
                    <span className="hq-score hq-score-allies">
                        {showCurrent && s.alliesScore != null ? s.alliesScore : '–'}
                    </span>
                    <span className="hq-score-dash">—</span>
                    <span className="hq-score hq-score-axis">
                        {showCurrent && s.axisScore != null ? s.axisScore : '–'}
                    </span>
                </div>
                <div className={`hq-clock${s.timerFrozen ? ' hq-clock-frozen' : ''}`}>
                    {showCurrent && anchor
                        ? <Timer timeleft={anchor.timeleft} timeleftAt={anchor.at} frozen={s.timerFrozen} />
                        : <span>--:--</span>}
                </div>
            </div>

            <HqFlagStrip flags={showCurrent ? s.flags : []} />

            {hasPlayers ? (
                <>
                    <HqRoster team="allies" players={s.allies} />
                    <HqRoster team="axis" players={s.axis} />
                </>
            ) : (
                <div className="hq-empty">{EMPTY_MESSAGE[s.status]}</div>
            )}
        </section>
    );
};

export default HqStrip;
