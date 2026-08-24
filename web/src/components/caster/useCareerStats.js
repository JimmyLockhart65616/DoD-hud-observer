import { useEffect, useRef, useState } from 'react';

const API_URL = process.env.REACT_APP_API_URL || '';

/**
 * Matches MAX_CAREER_BATCH in backend/src/statsdb/queries.ts. The backend
 * answers 400 above it, so trimming here keeps a full 12-man plus a bench from
 * turning into a hard error on the page.
 */
const MAX_IDS = 24;

/**
 * Career totals move only when a match ENDS, so this is deliberately slow. The
 * backend caches for 120s and rate-limits per IP; a caster page that re-polled on
 * the broadcast cadence would spend that budget on numbers that cannot have
 * changed.
 */
const REFRESH_MS = 300_000;

/** Back-off after a 429 or a transient failure, so one bad tab stops making it worse. */
const BACKOFF_MS = 120_000;

/**
 * Roster career totals from the league stats database (`GET /api/stats/players`).
 *
 * Returns `{ careers, status }`, where `careers` is keyed by the HUD-form
 * SteamID and `status` is one of:
 *
 *   'loading'      — first request in flight
 *   'ready'        — usable; `careers` is populated, possibly with gaps
 *   'unavailable'  — the stats database is not configured on this instance, or
 *                    it is shedding load. POLLING STOPS PERMANENTLY.
 *   'error'        — transient failure with nothing cached yet
 *
 * 'unavailable' is the DEFAULT in production today — `stats_db.enabled` stays
 * false until a read-only MySQL user exists on the data server — which is why the
 * caller must hide the panel on it rather than render an empty table. A
 * permanently blank panel on a caster's monitor reads as a broken page, not as a
 * feature that is switched off.
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

                // Not configured, or the guard is shedding. Either way: stand
                // down and stop asking.
                if (res.status === 503) {
                    disabled.current = true;
                    if (!cancelled) setState({ careers: {}, status: 'unavailable' });
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

        fetchOnce();
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, [key]);

    return state;
}

export default useCareerStats;
