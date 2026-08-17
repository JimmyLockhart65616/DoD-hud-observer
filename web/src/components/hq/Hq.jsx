// ─── HQ / Operations Board ──────────────────────────────────────────────────
//
// One page, every reporting server, for a wall display. Route: /hq
//
// HARD RULE: nothing under components/hq may import from core/Socket/Socket.
// Socket.jsx calls socketio.connect() at MODULE TOP LEVEL and reads the room
// from window.location.search in the same breath. Importing ANYTHING from it —
// even just useHudStore for a type — opens a socket and, with no ?server=/?match=
// param, joins the legacy `hud_socket` firehose, merging every server's events
// into a module-level singleton store. That store plus 8 module-level mutable
// globals cannot support two concurrent consumers, and its cleanup is a global
// gameEvents.removeAllListeners(). That is why this page polls REST instead.
// Enforced by Hq.socketfree.test.js.
//
// The only permitted reach into core/ is Timer (countdown display logic) and
// humanize (flag name formatting) — both pure-props, React-only modules.

import React, { useEffect, useState } from 'react';
import { useHqOverview } from './useHqOverview';
import HqStrip from './HqStrip';
import './Hq.css';

/** The board is authored at exactly this size and scaled to fit the display. */
const CANVAS_W = 1920;
const CANVAS_H = 1080;

/** Poll is 1 Hz; flag the feed once we're clearly missing frames. */
const STALE_FEED_MS = 5000;

/**
 * Statuses that mean a KTP match is under way in some form — everything the
 * backend's deriveStatus can return off a plugin-reported match phase, plus the
 * legacy LIVE/WARMUP. Excludes BETWEEN (no match), STALE and NO_SIGNAL.
 */
const MATCH_STATUSES = new Set([
    'LIVE', 'GOLIVE', 'HALFTIME', 'OTBREAK', 'FINAL', 'WARMUP',
]);

/**
 * Scale the fixed 1920x1080 canvas to fit the viewport, letterboxing rather
 * than clipping on non-16:9 displays.
 *
 * This exists because the venue display resolution is unknown. Authoring at a
 * fixed size and scaling means "correct on the dev monitor" guarantees correct
 * everywhere, which fluid units cannot promise — they'd re-wrap text at sizes we
 * never tested. `?scale=` overrides it for on-site nudging without a rebuild.
 *
 * CSS can't express this: calc(100vw / 1920) yields a length, and scale() needs
 * a unitless number.
 */
function useCanvasScale(override) {
    const [scale, setScale] = useState(1);

    useEffect(() => {
        if (override != null) {
            setScale(override);
            return;
        }
        const fit = () => setScale(Math.min(
            window.innerWidth / CANVAS_W,
            window.innerHeight / CANVAS_H,
        ));
        fit();
        window.addEventListener('resize', fit);
        return () => window.removeEventListener('resize', fit);
    }, [override]);

    return scale;
}

/** Revision-stamp clock, matching the dossier register of dodworldseries.com. */
const HqClock = () => {
    const [now, setNow] = useState(() => new Date());

    useEffect(() => {
        const id = setInterval(() => setNow(new Date()), 1000);
        return () => clearInterval(id);
    }, []);

    const date = now.toLocaleDateString('en-US', {
        day: '2-digit', month: 'short', year: 'numeric',
    }).toUpperCase().replace(/,/g, '');
    const time = now.toLocaleTimeString('en-US', {
        hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

    return <span className="hq-topbar-clock">{date} / {time}</span>;
};

const Hq = () => {
    const { servers, anchors, receivedAt, error, loaded } = useHqOverview(1000);

    const params = new URLSearchParams(window.location.search);
    const rawScale = parseFloat(params.get('scale'));
    const scale = useCanvasScale(Number.isFinite(rawScale) && rawScale > 0 ? rawScale : null);

    const inGame = servers.reduce((sum, s) => sum + s.playerCount, 0);
    // "Active" = something is actually happening on the station, which includes
    // pub play (status BETWEEN with players). Counting only LIVE/WARMUP produced
    // the contradictory "0 ACTIVE · 8 IN GAME". A set rather than a chain of
    // comparisons so the plugin-phase statuses can't be forgotten here — a
    // server at HALFTIME is very much active.
    const liveCount = servers.filter(
        s => MATCH_STATUSES.has(s.status) || s.playerCount > 0,
    ).length;
    const feedStale = receivedAt > 0 && Date.now() - receivedAt > STALE_FEED_MS;

    // Every reporting server is delayed by the same amount in practice (one
    // hltv_sync config), so a single top-bar chip is honest; per-strip labels in
    // HqStrip cover a mixed fleet.
    const delays = [...new Set(servers.filter(s => s.delayActive).map(s => s.delaySeconds))];
    const allDelayed = servers.length > 0 && servers.every(s => s.delayActive);
    const delayLabel = allDelayed && delays.length === 1 && delays[0] != null
        ? `BROADCAST DELAYED −${Math.round(delays[0])}s`
        : allDelayed ? 'BROADCAST DELAYED' : null;

    return (
        <div className="hq-board">
            <div
                className="hq-canvas"
                style={{ transform: `translate(-50%, -50%) scale(${scale})` }}
            >
                <header className="hq-topbar">
                    <span className="hq-topbar-title">
                        KTP <span className="hq-topbar-rule">—</span> OPERATIONS BOARD
                    </span>
                    <span className="hq-topbar-meta">
                        {delayLabel && <span className="hq-chip hq-chip-delay">{delayLabel}</span>}
                        {(error || feedStale) && (
                            <span className="hq-chip hq-chip-warn" title={error || 'no fresh poll'}>
                                FEED
                            </span>
                        )}
                        <span className="hq-topbar-stat">
                            {servers.length} STATION{servers.length === 1 ? '' : 'S'}
                        </span>
                        <span className="hq-topbar-sep">·</span>
                        <span className="hq-topbar-stat">{liveCount} ACTIVE</span>
                        <span className="hq-topbar-sep">·</span>
                        <span className="hq-topbar-stat">{inGame} IN GAME</span>
                        <HqClock />
                    </span>
                </header>

                {servers.length === 0 ? (
                    <div className="hq-awaiting">
                        <div className="hq-awaiting-title">
                            {loaded ? 'AWAITING SIGNAL' : 'CONNECTING'}
                        </div>
                        <div className="hq-awaiting-sub">
                            {loaded
                                ? 'No server has reported to this backend yet.'
                                : 'Contacting the event backend…'}
                        </div>
                    </div>
                ) : (
                    <div className="hq-strips">
                        {servers.map((s, i) => (
                            <HqStrip
                                key={s.hostname}
                                index={i + 1}
                                server={s}
                                anchor={anchors[s.hostname]}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default Hq;
