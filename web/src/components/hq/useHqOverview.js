import { useEffect, useRef, useState } from 'react';

const API_URL = process.env.REACT_APP_API_URL || '';

/**
 * Re-anchor the countdown only on a real jump — a time_sync correction, a half
 * change, a match boundary. Below this threshold the anchor is left alone and
 * Timer free-runs off it. Without this, re-anchoring on every 1 Hz poll lets
 * network jitter bounce the displayed digit back and forth across a floor
 * boundary (4:31 -> 4:32 -> 4:31), which is glaring on a wall display.
 */
const REANCHOR_THRESHOLD_S = 1.5;

/**
 * Polls GET /api/hq and maintains a stable countdown anchor per server.
 *
 * The anchor is `{ timeleft, at }` where `at` is the CLIENT's Date.now() at
 * receipt. The backend sends `timeleft` already age-adjusted to its own
 * serialization instant and deliberately sends no absolute timestamp, so the
 * countdown basis is formed entirely from the client's own clock — backend/display
 * clock skew cannot enter.
 *
 * Anchors live in a ref mutated inside the effect, never during render:
 * React.StrictMode (web/src/index.jsx) double-invokes render, so a render-time
 * mutation would advance twice per pass in dev.
 */
export function useHqOverview(intervalMs = 1000) {
    const [state, setState] = useState({
        servers: [],
        anchors: {},
        receivedAt: 0,
        error: null,
        generatedAt: null,
        loaded: false,
    });

    const anchors = useRef({});
    const inFlight = useRef(false);

    useEffect(() => {
        let cancelled = false;

        const tick = async () => {
            // Never stack polls behind a slow response.
            if (inFlight.current) return;
            inFlight.current = true;
            try {
                const res = await fetch(`${API_URL}/api/hq`, { cache: 'no-store' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const json = await res.json();
                const at = Date.now();
                if (cancelled) return;

                const servers = json.servers || [];
                const seen = new Set();

                for (const s of servers) {
                    seen.add(s.hostname);
                    if (s.timeleft == null) {
                        delete anchors.current[s.hostname];
                        continue;
                    }
                    const prev = anchors.current[s.hostname];
                    if (!prev) {
                        anchors.current[s.hostname] = { timeleft: s.timeleft, at };
                        continue;
                    }
                    const predicted = prev.timeleft - (at - prev.at) / 1000;
                    if (Math.abs(s.timeleft - predicted) > REANCHOR_THRESHOLD_S) {
                        anchors.current[s.hostname] = { timeleft: s.timeleft, at };
                    }
                }

                // Drop anchors for servers that fell off the board entirely.
                for (const host of Object.keys(anchors.current)) {
                    if (!seen.has(host)) delete anchors.current[host];
                }

                setState({
                    servers,
                    anchors: { ...anchors.current },
                    receivedAt: at,
                    error: null,
                    generatedAt: json.generatedAt ?? null,
                    loaded: true,
                });
            } catch (err) {
                // Keep the last good frame and surface the error as a chip.
                // Blanking a wall display on one dropped poll is worse than
                // showing data that's a few seconds stale.
                if (!cancelled) {
                    setState(prev => ({ ...prev, error: err.message, loaded: true }));
                }
            } finally {
                inFlight.current = false;
            }
        };

        tick();
        const id = setInterval(tick, intervalMs);
        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [intervalMs]);

    return state;
}
