import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { unstable_batchedUpdates } from 'react-dom';
import gameEvents from '../gameEvents';
import { resetHudState } from '../Socket/Socket';
import { replayTimeline, mergeOnClock } from './replayClock';
import { createReplayEngine } from './replayEngine';
import {
    buildClockTimeline, clockAt, findClock, parseClock, formatClock, halfLabel,
} from './demoClock';

import './Replay.css';

// Origin-relative (see MatchPicker): unset ⇒ same-origin relative `/api/...`.
const API_URL = process.env.REACT_APP_API_URL || '';

// How often the driver advances virtual time. Wall-clock deltas are measured,
// so a throttled background tab (OBS) still plays at the right speed, just in
// coarser steps.
const FRAME_MS = 50;
const SKIP_MS = 10000;

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
 * moves in whole seconds. replayClock() paces by tick within a map and uses
 * the wall stamp only to find and place each map.
 *
 * Playback runs on a virtual clock (replayEngine + hudClock), so the HUD's
 * countdowns and TTLs follow the replay: they stop when it pauses, scale with
 * its speed, and land correctly after a seek.
 */
function Replay({ matchId }) {
    const [events, setEvents] = useState(null);
    const [stateRows, setStateRows] = useState(null);   // player_state.jsonl, when recorded
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState(1);
    const [now, setNow] = useState(0);          // engine time, epoch ms
    const [drag, setDrag] = useState(null);     // slider value while dragging
    const [demoDraft, setDemoDraft] = useState(null);   // { text, half } while editing
    const [demoError, setDemoError] = useState(null);

    const engineRef = useRef(null);
    const resumeAtRef = useRef(null);
    const dragRef = useRef(null);
    const speedRef = useRef(speed);
    speedRef.current = speed;

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

    // The player_state stream, when the match was recorded with it: the weapon
    // in hand, grenades, wave pills, scoring tick. ~15 MB for a full match, so
    // it never holds up playback; it is merged in whenever it lands. A 404 is
    // the normal answer for a match recorded without it.
    useEffect(() => {
        let cancelled = false;
        fetch(`${API_URL}/api/matches/${encodeURIComponent(matchId)}/player_state`)
            .then(r => (r.ok ? r.json() : null))
            .then(data => { if (!cancelled && data && Array.isArray(data.events)) setStateRows(data.events); })
            .catch(() => { /* replay works without it */ });
        return () => { cancelled = true; };
    }, [matchId]);

    const timeline = useMemo(() => (events ? replayTimeline(events) : null), [events]);
    const clockTimeline = useMemo(
        () => (events && timeline ? buildClockTimeline(events, timeline.clock, timeline.mapOf) : []),
        [events, timeline]);
    // What actually plays: the events, plus player_state rows placed on the
    // same schedule once they arrive.
    const playlist = useMemo(() => {
        if (!events || !timeline) return null;
        if (!stateRows || stateRows.length === 0) return { events, clock: timeline.clock };
        return mergeOnClock(events, timeline, stateRows);
    }, [events, timeline, stateRows]);

    // One engine per playlist. It owns the HUD clock until unmount. When the
    // playlist grows (player_state landed) the new engine picks up where the
    // old one was.
    useEffect(() => {
        if (!playlist || playlist.events.length === 0) return undefined;
        resetHudState();
        const engine = createReplayEngine({
            events: playlist.events,
            clock: playlist.clock,
            emit: evt => gameEvents.emit(evt.event, JSON.stringify(evt)),
            reset: resetHudState,
            batch: unstable_batchedUpdates,
        });
        if (resumeAtRef.current != null && resumeAtRef.current > engine.start) engine.seek(resumeAtRef.current);
        engineRef.current = engine;
        setNow(engine.now);
        return () => {
            resumeAtRef.current = engine.now;
            engine.dispose();
            engineRef.current = null;
        };
    }, [playlist]);

    // The driver: advance virtual time by measured wall time × speed.
    useEffect(() => {
        if (!playing) return undefined;
        let last = Date.now();
        const id = setInterval(() => {
            const engine = engineRef.current;
            if (!engine) return;
            const wall = Date.now();
            engine.advanceTo(engine.now + (wall - last) * speedRef.current);
            last = wall;
            setNow(engine.now);
            if (engine.done) setPlaying(false);
        }, FRAME_MS);
        return () => clearInterval(id);
    }, [playing]);

    const seek = useCallback((t) => {
        const engine = engineRef.current;
        if (!engine) return;
        engine.seek(t);
        setNow(engine.now);
    }, []);

    const togglePlay = useCallback(() => {
        const engine = engineRef.current;
        if (!engine) return;
        if (!playing && engine.done) seek(engine.start);
        setPlaying(p => !p);
    }, [playing, seek]);

    const restart = useCallback(() => {
        const engine = engineRef.current;
        if (!engine) return;
        setPlaying(false);
        seek(engine.start);
    }, [seek]);

    // A drag previews and seeks once, on release: a backward seek re-feeds the
    // match from the start, which is too slow to repeat on every pointer move.
    // Released on the window, not the slider, so a release off the bar counts.
    const beginDrag = useCallback(() => {
        const engine = engineRef.current;
        if (!engine) return;
        dragRef.current = engine.now - engine.start;
        setDrag(dragRef.current);
        const finish = () => {
            window.removeEventListener('pointerup', finish);
            window.removeEventListener('pointercancel', finish);
            const value = dragRef.current;
            dragRef.current = null;
            setDrag(null);
            if (value != null && engineRef.current) seek(engineRef.current.start + value);
        };
        window.addEventListener('pointerup', finish);
        window.addEventListener('pointercancel', finish);
    }, [seek]);

    // Space toggles, arrows skip 10s — unless the viewer is typing somewhere or
    // on a button (space already clicks a focused button). The slider counts as
    // "not typing": its native arrow step is a quarter-second.
    useEffect(() => {
        const onKey = (e) => {
            const tag = (e.target && e.target.tagName) || '';
            const onSlider = e.target && e.target.classList && e.target.classList.contains('replay-slider');
            if (!onSlider && (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON')) return;
            const engine = engineRef.current;
            if (!engine) return;
            if (e.key === ' ') { e.preventDefault(); togglePlay(); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(engine.now - SKIP_MS); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); seek(engine.now + SKIP_MS); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [togglePlay, seek]);

    if (loading) return <div className="replay-bar">Loading replay...</div>;
    if (error) return <div className="replay-bar">Replay error: {error}</div>;
    if (!events || events.length === 0) return <div className="replay-bar">No events to replay.</div>;

    const engine = engineRef.current;
    const totalEvents = playlist ? playlist.events.length : events.length;
    const start = engine ? engine.start : timeline.clock[0];
    const end = engine ? engine.end : timeline.clock[timeline.clock.length - 1];
    const total = Math.max(0, end - start);
    const shown = drag ?? (now - start);

    // Demo clock: live reading unless the viewer is typing one.
    const reading = clockAt(clockTimeline, drag != null ? start + drag : now);
    const halves = clockTimeline.map(h => h.half).filter((h, i, a) => a.indexOf(h) === i);
    const demoText = demoDraft ? demoDraft.text : (reading ? formatClock(reading.seconds) : '');
    const demoHalf = demoDraft ? demoDraft.half : (reading ? reading.half : halves[0]);

    const commitDemo = () => {
        if (!demoDraft) return;
        const seconds = parseClock(demoDraft.text);
        if (seconds == null) { setDemoError('Type the clock as M:SS'); return; }
        const v = findClock(clockTimeline, demoDraft.half, seconds);
        if (v == null) {
            setDemoError(`${halfLabel(demoDraft.half)} never read ${formatClock(seconds)}`);
            return;
        }
        setDemoError(null);
        setDemoDraft(null);
        seek(v);
    };

    const halfMarks = clockTimeline
        .filter(() => total > 0)
        .map(h => ({ half: h.half, pct: ((h.start - start) / total) * 100 }));

    return (
        <div className="replay-bar">
            <span className="replay-label">REPLAY</span>
            <button className="replay-btn" onClick={togglePlay} title="Play / pause (space)">
                {playing ? '⏸' : '▶'}
            </button>
            <button className="replay-btn" onClick={restart} title="Back to the start">
                {'⏮'}
            </button>
            <select className="replay-speed" value={speed} onChange={e => setSpeed(Number(e.target.value))}>
                <option value={0.5}>0.5x</option>
                <option value={1}>1x</option>
                <option value={2}>2x</option>
                <option value={4}>4x</option>
                <option value={8}>8x</option>
            </select>
            <div className="replay-seek">
                {halfMarks.map(m => (
                    <span key={`${m.half}-${m.pct}`} className="replay-half-mark" style={{ left: `${m.pct}%` }}>
                        {halfLabel(m.half)}
                    </span>
                ))}
                <input
                    className="replay-slider"
                    type="range"
                    min={0}
                    max={total}
                    step={250}
                    value={Math.min(total, Math.max(0, shown))}
                    aria-label="Replay position"
                    onPointerDown={beginDrag}
                    onChange={e => {
                        const value = Number(e.target.value);
                        if (dragRef.current != null) {
                            dragRef.current = value;
                            setDrag(value);
                        } else {
                            seek(start + value);
                        }
                    }}
                />
            </div>
            <span className="replay-time">
                {formatTime(shown / 1000)} / {formatTime(total / 1000)}
            </span>
            <span
                className={`replay-demo${demoError ? ' replay-demo-error' : ''}`}
                title={demoError || 'Type the clock the demo shows, then Enter'}
                onBlur={e => {
                    // Moving between the box and the half picker keeps the draft;
                    // leaving the control goes back to the live reading.
                    if (e.currentTarget.contains(e.relatedTarget)) return;
                    setDemoDraft(null);
                    setDemoError(null);
                }}
            >
                <span className="replay-demo-label">Demo reads</span>
                <input
                    className="replay-demo-input"
                    type="text"
                    inputMode="numeric"
                    placeholder="M:SS"
                    value={demoText}
                    aria-label="Demo clock"
                    onFocus={() => { if (!demoDraft) setDemoDraft({ text: demoText, half: demoHalf }); }}
                    onChange={e => { setDemoError(null); setDemoDraft({ text: e.target.value, half: demoHalf }); }}
                    onKeyDown={e => {
                        if (e.key === 'Enter') commitDemo();
                        else if (e.key === 'Escape') e.target.blur();
                    }}
                />
                <select
                    className="replay-speed"
                    value={demoHalf ?? ''}
                    aria-label="Demo half"
                    disabled={halves.length === 0}
                    onChange={e => setDemoDraft({ text: demoText, half: Number(e.target.value) })}
                >
                    {halves.map(h => <option key={h} value={h}>{halfLabel(h)}</option>)}
                </select>
                <button className="replay-btn replay-demo-go" onMouseDown={e => e.preventDefault()} onClick={commitDemo} disabled={!demoDraft}>
                    Go
                </button>
                {demoError && <span className="replay-demo-msg">{demoError}</span>}
            </span>
            <span className="replay-count">
                {engine ? engine.index : 0}/{totalEvents}
            </span>
        </div>
    );
}

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

export default Replay;
