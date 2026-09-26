import { useCallback, useEffect, useState } from 'react';

import { setCasterSession } from '../core/Socket/Socket';
import gameEvents from '../core/gameEvents';

const STORAGE_KEY = 'hud.caster_token';

/**
 * The one login this app has — see backend/src/handler/casterAuth.ts and the
 * broadcast-director 2026-09-25 access-control decision. `/caster` renders
 * nothing live until this reports `loggedIn`; the actual data-layer gate
 * (positions never reach an unauthenticated socket at all) lives server-side
 * and does not depend on this component behaving — this is the UI half.
 *
 * try/catch around localStorage mirrors useMinimapToggle: a caster's OBS
 * browser source can run in private mode or block storage outright, and
 * "always show login" is the right degradation, not a crash.
 */
export function useCasterAuth(serverName) {
    const [token, setToken] = useState(null);
    const [ready, setReady] = useState(false); // true once localStorage has been checked once
    const [error, setError] = useState(null);
    const [pending, setPending] = useState(false);

    useEffect(() => {
        try {
            const stored = window.localStorage.getItem(STORAGE_KEY);
            if (stored) setToken(stored);
        } catch (e) { /* storage blocked — falls through to the login form */ }
        setReady(true);
    }, []);

    // Joins/leaves the caster room as the token or the server param changes —
    // covers login, logout, and a mid-session server switch alike.
    useEffect(() => {
        setCasterSession(token && serverName ? serverName : null, token);
        return () => setCasterSession(null, null);
    }, [token, serverName]);

    // The server refusing a stale/forged token (12h TTL, or a secret
    // rotation) surfaces here as a plain socket event, not a page reload —
    // dropping straight back to the login form is what "expired mid-cast"
    // should look like, not a silently-dead cue rail.
    useEffect(() => {
        const onAuthError = () => {
            setToken(null);
            setError('Your session expired — log in again.');
            try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* nothing to clean up */ }
        };
        gameEvents.on('caster_auth_error', onAuthError);
        return () => gameEvents.off('caster_auth_error', onAuthError);
    }, []);

    const login = useCallback(async (username, password) => {
        setPending(true);
        setError(null);
        try {
            const res = await fetch('/api/caster-auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });
            if (!res.ok) {
                setError('Wrong username or password.');
                return false;
            }
            const body = await res.json();
            try { window.localStorage.setItem(STORAGE_KEY, body.token); } catch (e) { /* usable for this tab regardless */ }
            setToken(body.token);
            return true;
        } catch (e) {
            setError('Could not reach the login server.');
            return false;
        } finally {
            setPending(false);
        }
    }, []);

    const logout = useCallback(() => {
        setToken(null);
        try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* nothing to clean up */ }
    }, []);

    return { loggedIn: !!token, ready, error, pending, login, logout };
}

export default useCasterAuth;
