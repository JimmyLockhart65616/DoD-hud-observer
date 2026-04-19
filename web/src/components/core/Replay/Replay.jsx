import React, { useEffect, useRef, useState, useCallback } from 'react';
import gameEvents from '../gameEvents';

import './Replay.css';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001';

/**
 * Replay engine — fetches events.jsonl for a match and plays them through
 * the shared gameEvents bus. SocketStoreComponent listens to gameEvents,
 * so all game-state logic works identically for live and replay.
 *
 * Uses the `tick` field on each event for timing. Events are sorted by tick,
 * then scheduled relative to the first event's tick value.
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

    // Fetch events on mount
    useEffect(() => {
        fetch(`${API_URL}/api/matches/${encodeURIComponent(matchId)}/events`)
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then(data => {
                const sorted = (data.events || []).sort((a, b) => (a.tick || 0) - (b.tick || 0));
                setEvents(sorted);
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
        const baseTick = events[0].tick || 0;
        const startTick = events[startFrom]?.tick || 0;
        startTimeRef.current = Date.now();

        // Schedule each remaining event
        for (let i = startFrom; i < events.length; i++) {
            const evt = events[i];
            const delaySeconds = (evt.tick || 0) - startTick;
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
            const replayElapsed = startTick - baseTick + (elapsedMs / 1000) * speedRef.current;
            setElapsed(replayElapsed);
        }, 250);

        setPlaying(true);
    }, [events, progress, clearTimers]);

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

    if (loading) return <div className="replay-bar">Loading replay...</div>;
    if (error) return <div className="replay-bar">Replay error: {error}</div>;
    if (!events || events.length === 0) return <div className="replay-bar">No events to replay.</div>;

    const totalDuration = (events[events.length - 1].tick || 0) - (events[0].tick || 0);
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

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

export default Replay;
