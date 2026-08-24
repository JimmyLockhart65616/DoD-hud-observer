import { useEffect, useRef, useState } from 'react';

const API_URL = process.env.REACT_APP_API_URL || '';

/**
 * Matches MAX_CAREER_BATCH in backend/src/statsdb/queries.ts. The backend
 * answers 400 above it, so trimming here keeps a full 12-man plus a bench from
 * turning into a hard error on the page.
 */
const MAX_IDS = 24;

/**
 * Wait for the roster to settle before asking.
 *
 * Players connect one at a time, so a filling 12-man changes the id set twelve
 * times in about a second. Without this the effect re-runs on each one and fires
 * twelve requests in a burst — which trips the backend's concurrency cap (4),
 * gets shed, and lands the panel in an error state at exactly the moment it
 * first has something to show. Observed against the local stack: 8 shed requests
 * on a single mocker run.
 */
const SETTLE_MS = 750;

/**
 * Career totals move only when a match ENDS, so this is deliberately slow. The
 * backend caches for 120s and rate-limits per IP; a caster page that re-polled on
 * the broadcast cadence would spend that budget on numbers that cannot have
 * changed.
 */
const REFRESH_MS = 300_000;

/** Back-off after a 429, a shed, or a transient failure. */
const BACKOFF_MS = 120_000;

/**
 * Roster career totals from the league stats database (`GET /api/stats/players`).
 *
 * Returns `{ careers, status }`, where `careers` is keyed by the HUD-form
 * SteamID and `status` is one of:
 *
 *   'loading'      — first request in flight, or waiting for the roster to settle
 *   'ready'        — usable; `careers` is populated, possibly with gaps
 *   'unavailable'  — the stats database is not configured on this instance.
 *                    PERMANENT: polling stops for the life of the page.
 *   'error'        — transient failure (shed, rate-limited, network); retried
 *
 * 'unavailable' is the DEFAULT in production today — `stats_db.enabled` stays
 * false until a read-only MySQL user exists on the data server — which is why the
 * caller must hide the panel on it rather than render an empty table. A
 * permanently blank panel on a caster's monitor reads as a broken page, not as a
 * feature that is switched off.
 *
 * THE TWO 503s ARE NOT THE SAME and the distinction is load-bearing. The backend
 * tags them: `reason: 'disabled'` is permanent, `reason: 'shedding'` is the guard
 * doing its job and recovering on its own. Latching off for a shed would defeat
 * the breaker — the panel would stay dark for the rest of the broadcast because
 * the data server was briefly busy once. Only 'disabled' latches.
 *
 * ONE request for the whole roster, never one per player (see the route comment
 * in backend/src/app.ts). Ids are sorted so the server's cache entry is shared
 * regardless of the order players happened to connect in.
 *
 * A missing key means "no league matches recorded", which is NOT the same as a
 * player who played and scored nothing — the panel renders the two differently.
 */
export function useCareerStats(steamIds) {
    const [state, setState] = useState({ careers: {}, status: 'loading' });

    // Sorted and de-duplicated so a reconnect reordering the roster does not
    // re-trigger the effect. This string IS the dependency.
    const key = Array.from(new Set((steamIds || []).filter(Boolean)))
        .sort()
        .slice(0, MAX_IDS)
        .join(',');

    // Survives across effect runs: once the backend has said the database is not
    // configured, no later roster change should start polling again.
    const disabled = useRef(false);

    useEffect(() => {
        if (!key || disabled.current) return undefined;

        let cancelled = false;
        let timer = null;

        const schedule = (ms) => {
            if (cancelled) return;
            timer = setTimeout(fetchOnce, ms);
        };

        const fetchOnce = async () => {
            try {
                const res = await fetch(
                    `${API_URL}/api/stats/players?ids=${encodeURIComponent(key)}`,
                    { cache: 'no-store' },
                );

                if (res.status === 503) {
                    // Read the body to tell permanent from transient. An older
                    // backend sends no `reason`; treat that as permanent, which
                    // is the pre-existing behaviour and the safe direction for
                    // an instance that genuinely has no database.
                    let reason = 'disabled';
                    try {
                        reason = (await res.json())?.reason ?? 'disabled';
                    } catch (e) { /* empty or non-JSON body — keep the default */ }

                    if (reason === 'disabled') {
                        disabled.current = true;
                        if (!cancelled) setState({ careers: {}, status: 'unavailable' });
                        return;
                    }
                    // Shedding: back off and try again. The guard recovers by
                    // itself, so giving up here would defeat it.
                    if (!cancelled) {
                        setState(s => ({
                            careers: s.careers,
                            status: Object.keys(s.careers).length ? 'ready' : 'error',
                        }));
                    }
                    schedule(BACKOFF_MS);
                    return;
                }

                if (res.status === 429) {
                    schedule(BACKOFF_MS);
                    return;
                }
                if (!res.ok) throw new Error(`HTTP ${res.status}`);

                const json = await res.json();
                if (cancelled) return;
                setState({ careers: json.players || {}, status: 'ready' });
                schedule(REFRESH_MS);
            } catch (err) {
                // Keep whatever we already have — a dropped poll must not blank a
                // reference monitor mid-broadcast.
                if (!cancelled) {
                    setState(s => ({
                        careers: s.careers,
                        status: Object.keys(s.careers).length ? 'ready' : 'error',
                    }));
                }
                schedule(BACKOFF_MS);
            }
        };

        // Settle first, so a roster filling in one player at a time costs one
        // request rather than one per player.
        schedule(SETTLE_MS);

        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, [key]);

    return state;
}

export default useCareerStats;
