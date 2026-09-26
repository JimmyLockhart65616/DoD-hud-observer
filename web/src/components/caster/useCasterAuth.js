import { useCallback, useEffect, useState } from 'react';

import { setCasterSession } from '../core/Socket/Socket';
import gameEvents from '../core/gameEvents';

const STORAGE_KEY = 'hud.caster_token';

/** Pulled out of the hook so a test can check the URL without stubbing
 * `window.location` (jsdom does not really follow a `location.href` write). */
export function discordLoginUrl(serverName) {
    return `/api/caster-auth/discord/login?server=${encodeURIComponent(serverName)}`;
}

const ERROR_MESSAGES = {
    discord_failed: 'Discord login failed — try again.',
    not_authorized: "This Discord account isn't authorized to cast.",
};

/**
 * The one login this app has — Discord OAuth2, see
 * backend/src/handler/casterAuth.ts and the broadcast-director 2026-09-25
 * access-control decision. `/caster` renders nothing live until this reports
 * `loggedIn`; the actual data-layer gate (positions never reach an
 * unauthenticated socket at all) lives server-side and does not depend on
 * this component behaving — this is the UI half.
 *
 * Login is a full-page redirect (`login()` sends the browser to
 * `/api/caster-auth/discord/login`), not a form submit: Discord's own login
 * UI has to render, so there is no fetch-and-get-a-token-back call here.
 * The backend's callback redirects back to `/caster?...&caster_token=<token>`
 * on success, or `&caster_error=<reason>` on failure — this hook picks
 * either up from the URL on mount and immediately strips it via
 * `history.replaceState`, so a reload or a shared link never re-submits a
 * stale token or replays an error.
 *
 * try/catch around localStorage mirrors useMinimapToggle: a caster's OBS
 * browser source can run in private mode or block storage outright, and
 * "always show login" is the right degradation, not a crash.
 */
export function useCasterAuth(serverName) {
    const [token, setToken] = useState(null);
    const [ready, setReady] = useState(false); // true once the URL and localStorage have both been checked
    const [error, setError] = useState(null);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const fromUrlToken = params.get('caster_token');
        const fromUrlError = params.get('caster_error');

        if (fromUrlToken || fromUrlError) {
            params.delete('caster_token');
            params.delete('caster_error');
            const clean = `${window.location.pathname}?${params.toString()}`;
            window.history.replaceState({}, '', clean);
        }

        if (fromUrlToken) {
            try { window.localStorage.setItem(STORAGE_KEY, fromUrlToken); } catch (e) { /* usable for this tab regardless */ }
            setToken(fromUrlToken);
        } else if (fromUrlError) {
            setError(ERROR_MESSAGES[fromUrlError] || 'Login failed — try again.');
        } else {
            try {
                const stored = window.localStorage.getItem(STORAGE_KEY);
                if (stored) setToken(stored);
            } catch (e) { /* storage blocked — falls through to the login screen */ }
        }
        setReady(true);
        // Only ever runs once per page load — the URL is consulted at mount,
        // not on every serverName change.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Joins/leaves the caster room as the token or the server param changes —
    // covers login, logout, and a mid-session server switch alike.
    useEffect(() => {
        setCasterSession(token && serverName ? serverName : null, token);
        return () => setCasterSession(null, null);
    }, [token, serverName]);

    // The server refusing a stale/forged token (12h TTL, or a secret
    // rotation) surfaces here as a plain socket event, not a page reload —
    // dropping straight back to the login screen is what "expired mid-cast"
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

    const login = useCallback(() => {
        if (!serverName) return;
        window.location.href = discordLoginUrl(serverName);
    }, [serverName]);

    const logout = useCallback(() => {
        setToken(null);
        try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* nothing to clean up */ }
    }, []);

    return { loggedIn: !!token, ready, error, login, logout };
}

export default useCasterAuth;
