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

/**
 * BETWEEN means "no KTP match is running", which covers two very different
 * things: an empty server waiting for the next match, and a server full of
 * people playing pub. Calling the second one STANDBY reads as "nothing
 * happening here" next to nine players actively fragging.
 */
const statusLabel = s =>
    s.status === 'BETWEEN' && s.playerCount > 0 ? 'OPEN PLAY' : STATUS_LABEL[s.status];

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

    // Whether the cached game state is still being REFRESHED — i.e. whether
    // score/clock/flags describe now.
    //
    // The backend's state cache is never evicted, so a server that drops off
    // keeps reporting its last-known state forever; rendering that is actively
    // misleading, worst of all the clock, which free-runs client-side and would
    // tick down on a machine that has been off for an hour. But the thing that
    // makes state stale is the EVENT STREAM stopping, not the absence of a KTP
    // match: NO_SIGNAL (quiet >60s) and STALE (cache wiped by a restart) have
    // nothing current to show, while BETWEEN with a live stream is pub play —
    // real players, real score, real round clock, refreshed continuously.
    // Gating on LIVE/WARMUP blanked exactly that case.
    //
    // A genuinely finished match needs no gate here: ktp_match_end nulls
    // team_score and timeleft in the reducer, so an idle post-match server
    // renders "–" and "--:--" on its own.
    const dataFresh = s.status !== 'NO_SIGNAL' && s.status !== 'STALE';

    // Idle strips recede so live games read first from across a room — but a pub
    // server with players on it is not idle.
    const dimmed = !dataFresh || (s.status === 'BETWEEN' && !hasPlayers);

    return (
        <section className={`hq-strip hq-strip-${s.status.toLowerCase()}${dimmed ? ' hq-strip-dim' : ''}`}>
            <div className="hq-rail">
                <div className="hq-designator">{pad2(index)}</div>
                <div className="hq-servername">{shortName(s.hostname)}</div>
                <div className="hq-status">
                    <span className="hq-dot" />
                    <span className="hq-status-text">{statusLabel(s)}</span>
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
                        {dataFresh && s.alliesScore != null ? s.alliesScore : '–'}
                    </span>
                    <span className="hq-score-dash">—</span>
                    <span className="hq-score hq-score-axis">
                        {dataFresh && s.axisScore != null ? s.axisScore : '–'}
                    </span>
                </div>
                <div className={`hq-clock${s.timerFrozen ? ' hq-clock-frozen' : ''}`}>
                    {dataFresh && anchor
                        ? <Timer timeleft={anchor.timeleft} timeleftAt={anchor.at} frozen={s.timerFrozen} />
                        : <span>--:--</span>}
                </div>
            </div>

            <HqFlagStrip flags={dataFresh ? s.flags : []} />

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
