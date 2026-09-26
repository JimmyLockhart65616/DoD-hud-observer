/**
 * The one login this app has (see backend/src/handler/casterAuth.ts and the
 * broadcast-director 2026-09-25 access-control decision). Login is a
 * full-page redirect through Discord, not a form — the failure modes that
 * matter here are all in how the CALLBACK's redirect is consumed: a stored
 * token restoring a session, a fresh `caster_token` logging in and then
 * disappearing from the URL, a `caster_error` surfacing as a real message
 * without logging anyone in, and an expired session dropping straight back
 * to login rather than a dead page.
 *
 * Probe-component pattern mirrors useCareerStats.test.js.
 */

/* eslint-disable import/first */
jest.mock('socket.io-client', () => {
    const sock = { on: () => {}, onAny: () => {}, emit: () => {}, connect: () => {}, disconnect: () => {}, connected: true };
    return { __esModule: true, default: { connect: () => sock, io: () => sock }, connect: () => sock, io: () => sock };
});

import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { useCasterAuth, discordLoginUrl } from './useCasterAuth';
import gameEvents from '../core/gameEvents';

const STORAGE_KEY = 'hud.caster_token';

const Probe = ({ server = 'KTP - Test' }) => {
    const auth = useCasterAuth(server);
    return (
        <div>
            <span data-testid="ready">{String(auth.ready)}</span>
            <span data-testid="loggedIn">{String(auth.loggedIn)}</span>
            <span data-testid="error">{auth.error || ''}</span>
            <button onClick={auth.login}>login</button>
            <button onClick={auth.logout}>logout</button>
        </div>
    );
};

function setUrl(search) {
    window.history.pushState({}, '', `/caster${search}`);
}

beforeEach(() => {
    window.localStorage.clear();
    setUrl('?server=KTP - Test');
});

describe('discordLoginUrl', () => {
    test('points at the backend Discord login route with the server encoded', () => {
        expect(discordLoginUrl('KTP - Atlanta 1')).toBe('/api/caster-auth/discord/login?server=KTP%20-%20Atlanta%201');
    });
});

describe('useCasterAuth', () => {
    test('starts not ready, then ready + logged out with nothing stored and no URL params', async () => {
        render(<Probe />);
        expect(await screen.findByTestId('ready')).toHaveTextContent('true');
        expect(screen.getByTestId('loggedIn')).toHaveTextContent('false');
        expect(screen.getByTestId('error')).toHaveTextContent('');
    });

    test('a stored token restores the logged-in state on mount', async () => {
        window.localStorage.setItem(STORAGE_KEY, 'a-previously-issued-token');
        render(<Probe />);
        expect(await screen.findByTestId('loggedIn')).toHaveTextContent('true');
    });

    test('a caster_token in the URL logs in, persists it, and strips it from the URL', async () => {
        setUrl('?server=KTP - Test&caster_token=fresh-from-discord');
        render(<Probe />);

        expect(await screen.findByTestId('loggedIn')).toHaveTextContent('true');
        expect(window.localStorage.getItem(STORAGE_KEY)).toBe('fresh-from-discord');
        expect(window.location.search).not.toContain('caster_token');
        expect(window.location.search).toContain('server=KTP');
    });

    test('a caster_error in the URL shows a real message, logs nobody in, and strips itself', async () => {
        setUrl('?server=KTP - Test&caster_error=not_authorized');
        render(<Probe />);

        expect(await screen.findByTestId('ready')).toHaveTextContent('true');
        expect(screen.getByTestId('loggedIn')).toHaveTextContent('false');
        expect(screen.getByTestId('error')).toHaveTextContent("isn't authorized to cast");
        expect(window.location.search).not.toContain('caster_error');
    });

    test('an unrecognized error code still shows a generic message rather than nothing', async () => {
        setUrl('?server=KTP - Test&caster_error=something_new_the_backend_started_sending');
        render(<Probe />);
        expect(await screen.findByTestId('error')).not.toHaveTextContent('');
    });

    test('logout clears the stored token', async () => {
        window.localStorage.setItem(STORAGE_KEY, 'a-previously-issued-token');
        render(<Probe />);
        expect(await screen.findByTestId('loggedIn')).toHaveTextContent('true');

        await act(async () => { fireEvent.click(screen.getByText('logout')); });

        expect(screen.getByTestId('loggedIn')).toHaveTextContent('false');
        expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    test('a caster_auth_error event drops a live session back to logged out, with a message', async () => {
        window.localStorage.setItem(STORAGE_KEY, 'a-token-the-server-now-rejects');
        render(<Probe />);
        expect(await screen.findByTestId('loggedIn')).toHaveTextContent('true');

        act(() => { gameEvents.emit('caster_auth_error', JSON.stringify({ reason: 'invalid_or_expired_token' })); });

        expect(screen.getByTestId('loggedIn')).toHaveTextContent('false');
        expect(screen.getByTestId('error')).not.toHaveTextContent('');
        expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    });
});
