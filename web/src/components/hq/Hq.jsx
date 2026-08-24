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

import React, { useEffect, useMemo, useState } from 'react';
import { useHqOverview } from './useHqOverview';
import HqStrip from './HqStrip';
import {
    compactRowHeight, fitsCanvas, isIdleStation, EXPANDED_H_PX, MAX_AUTO_OPEN,
} from './hqLayout';
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
 * Above this many stations the board switches to compact rows.
 *
 * Six full strips is what the canvas comfortably holds; the fleet went to 24 on
 * 2026-08-23 and every strip was clipped to 31px of the 104px it needed. Seven
 * is the first count that genuinely doesn't fit, so that is where the switch
 * belongs — `?compact=1` / `?compact=0` forces it either way for a venue that
 * disagrees.
 */
const COMPACT_THRESHOLD = 6;

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

    // Per-station open/closed overrides from clicking a row. Keyed by hostname
    // rather than index so a station that changes position in the sort (or
    // disappears and returns) keeps whatever the operator chose for it.
    // A station with no entry here follows the automatic rule below. The
    // override has to be written against the row's CURRENT effective state, not
    // against the absent entry, or the first click on an auto-opened LIVE row
    // would "open" it again and appear to do nothing.
    const [opened, setOpened] = useState({});
    const toggle = (hostname, currentlyOpen) =>
        setOpened(prev => ({ ...prev, [hostname]: !currentlyOpen }));

    const hideIdle = params.get('hideIdle') === '1';
    const compactParam = params.get('compact');

    // Designators are assigned over the FULL list, so hiding idle stations
    // renumbers nothing — 19 stays 19 whether or not 03 is on screen.
    const designators = useMemo(() => {
        const m = {};
        servers.forEach((s, i) => { m[s.hostname] = i + 1; });
        return m;
    }, [servers]);

    const visible = hideIdle ? servers.filter(s => !isIdleStation(s)) : servers;
    const hiddenCount = servers.length - visible.length;

    // Keyed off the FULL fleet, not the filtered view: `?hideIdle=1` on a
    // 24-station fleet that happens to have one match running must not drop the
    // board back into the old one-strip-fills-the-screen grid.
    const compactMode = compactParam === '1' ? true
        : compactParam === '0' ? false
        : servers.length > COMPACT_THRESHOLD;

    // See MAX_AUTO_OPEN: past the cap nothing opens by itself.
    const autoOpenCount = visible.filter(s => MATCH_STATUSES.has(s.status)).length;
    const autoOpens = autoOpenCount > 0 && autoOpenCount <= MAX_AUTO_OPEN;

    // In compact mode a station opens if a match is running on it, or if
    // somebody clicked it open. Outside compact mode everything is open, which
    // is exactly the pre-2026-08-23 board.
    const isOpen = s => {
        const override = opened[s.hostname];
        if (override != null) return override;
        return !compactMode || (autoOpens && MATCH_STATUSES.has(s.status));
    };

    const openCount = visible.filter(isOpen).length;
    const rowHeight = compactRowHeight(visible.length, openCount);
    // Only reachable with an implausible number of concurrent matches; scrolling
    // beats the silent clipping that made this change necessary.
    const overflows = !fitsCanvas(visible.length, openCount);

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
                        {hiddenCount > 0 && (
                            <span className="hq-chip hq-chip-muted" title="?hideIdle=1 — idle stations are not shown">
                                {hiddenCount} IDLE HIDDEN
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

                {visible.length === 0 ? (
                    <div className="hq-awaiting">
                        <div className="hq-awaiting-title">
                            {servers.length > 0 ? 'ALL STATIONS IDLE'
                                : loaded ? 'AWAITING SIGNAL' : 'CONNECTING'}
                        </div>
                        <div className="hq-awaiting-sub">
                            {servers.length > 0
                                ? `${servers.length} station${servers.length === 1 ? '' : 's'} reporting, none with a match or a player on it.`
                                : loaded
                                    ? 'No server has reported to this backend yet.'
                                    : 'Contacting the event backend…'}
                        </div>
                    </div>
                ) : (
                    <div className={`hq-strips${compactMode ? ' hq-strips-compact' : ''}${overflows ? ' hq-strips-overflow' : ''}`}>
                        {visible.map(s => {
                            const open = isOpen(s);
                            return (
                                <HqStrip
                                    key={s.hostname}
                                    index={designators[s.hostname]}
                                    server={s}
                                    anchor={anchors[s.hostname]}
                                    expanded={open}
                                    // Both heights are explicit in compact mode so the column
                                    // adds up exactly; outside it the old 1fr grid still sizes.
                                    height={!compactMode ? undefined : open ? EXPANDED_H_PX : rowHeight}
                                    onToggle={compactMode ? () => toggle(s.hostname, open) : undefined}
                                />
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
};

export default Hq;
