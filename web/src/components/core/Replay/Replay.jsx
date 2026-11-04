import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import gameEvents from '../gameEvents';

import './Replay.css';

// Origin-relative (see MatchPicker): unset ⇒ same-origin relative `/api/...`.
const API_URL = process.env.REACT_APP_API_URL || '';

/**
 * Replay engine — fetches events.jsonl for a match and plays them through
 * the shared gameEvents bus. SocketStoreComponent listens to gameEvents,
 * so all game-state logic works identically for live and replay.
 *
 * Events play in the order the file recorded them: HTTP arrival order, which
 * crosses the halftime changelevel exactly once. Neither clock on an event can
 * drive the schedule alone. `tick` is `get_gametime()` and resets at that
 * changelevel, so ordering a two-half match by it interleaves the halves.
 * `plugin_sent_at` is epoch ms but stamped from `get_systime()`, so it only
 * moves in whole seconds. replayClock() below paces by tick within a map and
 * uses the wall stamp only to find and place each map.
 */
function Replay({ matchId }) {
    const [events, setEvents] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState(1);
    const [progress, setProgress] = useState(0);  // index of next event to play
    const [elapsed, setElapsed] = useState(0);     // seconds into the replay timeline

    const timersRef = useRef([]);
    const startTimeRef = useRef(null);
    const tickIntervalRef = useRef(null);
    const speedRef = useRef(speed);
    speedRef.current = speed;

    // Computed once per fetched list, not per render: play() schedules from it
    // and the progress bar reads it four times a second.
    const clock = useMemo(() => (events ? replayClock(events) : []), [events]);

    // Fetch events on mount
    useEffect(() => {
        fetch(`${API_URL}/api/matches/${encodeURIComponent(matchId)}/events`)
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then(data => {
                // Append-only arrival order already is the play order; sorting by any
                // per-half clock interleaves the halves.
                setEvents(data.events || []);
                setLoading(false);
            })
            .catch(err => {
                setError(err.message);
                setLoading(false);
            });
    }, [matchId]);

    const clearTimers = useCallback(() => {
        timersRef.current.forEach(t => clearTimeout(t));
        timersRef.current = [];
        if (tickIntervalRef.current) {
            clearInterval(tickIntervalRef.current);
            tickIntervalRef.current = null;
        }
    }, []);

    const play = useCallback(() => {
        if (!events || events.length === 0) return;
        clearTimers();

        const startFrom = progress;
        const baseAt = clock[0];
        const startAt = clock[startFrom] ?? baseAt;
        startTimeRef.current = Date.now();

        // Schedule each remaining event
        for (let i = startFrom; i < events.length; i++) {
            const evt = events[i];
            const delaySeconds = (clock[i] - startAt) / 1000;
            const delayMs = (delaySeconds / speedRef.current) * 1000;

            const idx = i;
            const timer = setTimeout(() => {
                // Emit into the shared event bus — SocketStoreComponent handles it
                gameEvents.emit(evt.event, JSON.stringify(evt));
                setProgress(idx + 1);
            }, delayMs);

            timersRef.current.push(timer);
        }

        // Elapsed-time ticker for the progress bar
        tickIntervalRef.current = setInterval(() => {
            const elapsedMs = Date.now() - startTimeRef.current;
            const replayElapsed = (startAt - baseAt) / 1000 + (elapsedMs / 1000) * speedRef.current;
            setElapsed(replayElapsed);
        }, 250);

        setPlaying(true);
    }, [events, clock, progress, clearTimers]);

    const pause = useCallback(() => {
        clearTimers();
        setPlaying(false);
    }, [clearTimers]);

    const restart = useCallback(() => {
        clearTimers();
        setProgress(0);
        setElapsed(0);
        setPlaying(false);
    }, [clearTimers]);

    // Cleanup on unmount
    useEffect(() => () => clearTimers(), [clearTimers]);

    // setTimeout delays are computed from speedRef.current at schedule time,
    // so a speed change mid-play doesn't retroactively adjust pending timers.
    // Re-run play() on speed change to reschedule from the current progress.
    useEffect(() => {
        if (playing) play();
        // play is intentionally excluded — it changes reference every progress
        // update, which would cause a reschedule on every event.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [speed]);

    if (loading) return <div className="replay-bar">Loading replay...</div>;
    if (error) return <div className="replay-bar">Replay error: {error}</div>;
    if (!events || events.length === 0) return <div className="replay-bar">No events to replay.</div>;

    const totalDuration = (clock[clock.length - 1] - clock[0]) / 1000;
    const pct = totalDuration > 0 ? Math.min(100, (elapsed / totalDuration) * 100) : 0;

    return (
        <div className="replay-bar">
            <span className="replay-label">REPLAY</span>
            <button className="replay-btn" onClick={playing ? pause : play}>
                {playing ? '\u23F8' : '\u25B6'}
            </button>
            <button className="replay-btn" onClick={restart}>
                {'\u23EE'}
            </button>
            <select className="replay-speed" value={speed} onChange={e => setSpeed(Number(e.target.value))}>
                <option value={0.5}>0.5x</option>
                <option value={1}>1x</option>
                <option value={2}>2x</option>
                <option value={4}>4x</option>
                <option value={8}>8x</option>
            </select>
            <div className="replay-progress-track">
                <div className="replay-progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="replay-time">
                {formatTime(elapsed)} / {formatTime(totalDuration)}
            </span>
            <span className="replay-count">
                {progress}/{events.length}
            </span>
        </div>
    );
}

// `tick` and `plugin_sent_at` are stamped in the same post_event() call, so within
// one map their difference is constant to within plugin_sent_at's one-second floor
// (measured: under 1 s of drift across a half on three recorded matches). The
// halftime changelevel moves it by the length of the map that just ended. So pace
// by `tick` inside a map, and use the wall stamp only to find where a new map
// starts and to place it. A late row from an earlier map (the old map's final
// player_disconnect rows arrive interleaved with the new map's first rows) is
// held at the current instant, not replayed at its old tick.
const NEW_MAP_MS = 30000; // same threshold as hltvDelayBuffer's TICK_RESET_THRESHOLD_S

export function replayClock(events) {
    const out = [];
    const maps = [];
    let high = null;
    for (const e of events) {
        const wall = e.plugin_sent_at;
        const tick = e.tick;
        if (typeof wall === 'number' && typeof tick === 'number') {
            const offset = wall - tick * 1000;
            let m = null;
            for (let j = maps.length - 1; j >= 0; j--) {
                if (Math.abs(maps[j].offset - offset) < NEW_MAP_MS) { m = maps[j]; break; }
            }
            if (!m) {
                m = { offset, firstTick: tick, maxTick: tick, startAt: Math.max(high ?? wall, wall) };
                maps.push(m);
            }
            if (m === maps[maps.length - 1]) {
                if (tick > m.maxTick) m.maxTick = tick;
                const at = m.startAt + (m.maxTick - m.firstTick) * 1000;
                if (high === null || at > high) high = at;
            }
        } else if (typeof wall === 'number' && (high === null || wall > high)) {
            high = wall;
        }
        out.push(high);
    }
    const first = out.find(v => v !== null) ?? 0;
    return out.map(v => (v === null ? first : v));
}

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

export default Replay;
