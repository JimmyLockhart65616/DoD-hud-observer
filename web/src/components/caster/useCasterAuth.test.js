/**
 * The one login this app has (see backend/src/handler/casterAuth.ts and the
 * broadcast-director 2026-09-25 access-control decision). The failure modes
 * that matter here are all silent on a caster's monitor if this hook gets
 * them wrong: a stored token that should restore a session, an expired
 * session that should drop straight back to login rather than a dead page,
 * and a login attempt whose result never reaches the person watching it type.
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
import { useCasterAuth } from './useCasterAuth';
import gameEvents from '../core/gameEvents';

const STORAGE_KEY = 'hud.caster_token';

const jsonResponse = (body, status = 200) => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
});

const Probe = ({ server = 'KTP - Test' }) => {
    const auth = useCasterAuth(server);
    return (
        <div>
            <span data-testid="ready">{String(auth.ready)}</span>
            <span data-testid="loggedIn">{String(auth.loggedIn)}</span>
            <span data-testid="error">{auth.error || ''}</span>
            <span data-testid="pending">{String(auth.pending)}</span>
            <button onClick={() => auth.login('coreymarko', 'let-me-cast')}>login</button>
            <button onClick={() => auth.logout()}>logout</button>
        </div>
    );
};

beforeEach(() => {
    window.localStorage.clear();
    global.fetch = jest.fn();
});

describe('useCasterAuth', () => {
    test('starts not ready, then ready + logged out with no stored token', async () => {
        render(<Probe />);
        expect(await screen.findByTestId('ready')).toHaveTextContent('true');
        expect(screen.getByTestId('loggedIn')).toHaveTextContent('false');
    });

    test('a stored token restores the logged-in state on mount', async () => {
        window.localStorage.setItem(STORAGE_KEY, 'a-previously-issued-token');
        render(<Probe />);
        expect(await screen.findByTestId('loggedIn')).toHaveTextContent('true');
    });

    test('a successful login sets loggedIn and persists the token', async () => {
        global.fetch.mockReturnValue(jsonResponse({ token: 'fresh-token' }));
        render(<Probe />);
        await screen.findByTestId('ready');

        await act(async () => { fireEvent.click(screen.getByText('login')); });

        expect(screen.getByTestId('loggedIn')).toHaveTextContent('true');
        expect(window.localStorage.getItem(STORAGE_KEY)).toBe('fresh-token');
        expect(global.fetch).toHaveBeenCalledWith('/api/caster-auth/login', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ username: 'coreymarko', password: 'let-me-cast' }),
        }));
    });

    test('a rejected login shows an error and stays logged out', async () => {
        global.fetch.mockReturnValue(jsonResponse({ error: 'invalid credentials' }, 401));
        render(<Probe />);
        await screen.findByTestId('ready');

        await act(async () => { fireEvent.click(screen.getByText('login')); });

        expect(screen.getByTestId('loggedIn')).toHaveTextContent('false');
        expect(screen.getByTestId('error')).not.toHaveTextContent('');
        expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    test('a network failure surfaces as an error rather than throwing', async () => {
        global.fetch.mockRejectedValue(new Error('network down'));
        render(<Probe />);
        await screen.findByTestId('ready');

        await act(async () => { fireEvent.click(screen.getByText('login')); });

        expect(screen.getByTestId('loggedIn')).toHaveTextContent('false');
        expect(screen.getByTestId('error')).not.toHaveTextContent('');
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
