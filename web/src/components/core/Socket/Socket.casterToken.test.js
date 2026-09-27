/**
 * Caster token intake — how a token reaches this page and what happens when
 * the backend refuses it.
 *
 * The token is read at MODULE LOAD, from the URL, so each test sets the URL
 * first and then loads a fresh copy of Socket.jsx with jest.isolateModules.
 * socket.io-client is mocked with a socket that records what the page emits
 * and exposes the handlers it registered, so a test can play the server.
 */

/* eslint-disable import/first */
const mockEmitted = [];
const mockHandlers = {};
jest.mock('socket.io-client', () => {
    const sock = {
        connected: true,
        on: (ev, fn) => { mockHandlers[ev] = fn; },
        onAny: () => {},
        emit: (...args) => { mockEmitted.push(args); },
        connect: () => {},
        disconnect: () => {},
    };
    return { __esModule: true, default: { connect: () => sock, io: () => sock }, connect: () => sock, io: () => sock };
});

const TOKEN_KEY = 'hud.caster_token';

function loadAt(url) {
    window.history.replaceState(null, '', url);
    let mod;
    jest.isolateModules(() => { mod = require('./Socket'); });
    return mod;
}

const joins = () => mockEmitted.filter(([ev]) => ev === 'join_caster').map(([, p]) => p);
const leaves = () => mockEmitted.filter(([ev]) => ev === 'leave_caster').map(([, s]) => s);

beforeEach(() => {
    mockEmitted.length = 0;
    Object.keys(mockHandlers).forEach(k => delete mockHandlers[k]);
    window.sessionStorage.clear();
});

describe('reading the token', () => {
    test('takes it from the fragment and joins the caster room on connect', () => {
        loadAt('/caster?server=KTP%20-%20Test#caster_token=tok-frag');
        mockHandlers.connect();
        expect(joins()).toEqual([{ server: 'KTP - Test', token: 'tok-frag' }]);
    });

    test('still accepts the older ?caster_token= form', () => {
        loadAt('/caster?server=KTP%20-%20Test&caster_token=tok-query');
        mockHandlers.connect();
        expect(joins()).toEqual([{ server: 'KTP - Test', token: 'tok-query' }]);
    });

    test('strips it from the address bar and keeps every other parameter', () => {
        loadAt('/caster?server=KTP%20-%20Test&minimap=1&caster_token=tok-query#caster_token=tok-frag');
        expect(window.location.href).not.toContain('caster_token');
        expect(window.location.search).toBe('?server=KTP+-+Test&minimap=1');
        expect(window.location.hash).toBe('');
    });

    test('survives a reload of the same tab via sessionStorage', () => {
        loadAt('/caster?server=KTP%20-%20Test#caster_token=tok-frag');
        expect(window.sessionStorage.getItem(TOKEN_KEY)).toBe('tok-frag');
        mockEmitted.length = 0;
        loadAt('/caster?server=KTP%20-%20Test');   // the reload: token already stripped
        mockHandlers.connect();
        expect(joins()).toEqual([{ server: 'KTP - Test', token: 'tok-frag' }]);
    });

    test('no token anywhere means no caster join at all', () => {
        loadAt('/caster?server=KTP%20-%20Test');
        mockHandlers.connect();
        expect(joins()).toEqual([]);
    });
});

describe('a refused token', () => {
    test('is forgotten: not replayed on the next reconnect, and not kept for a reload', () => {
        loadAt('/caster?server=KTP%20-%20Test#caster_token=tok-expired');
        mockHandlers.connect();
        mockHandlers.caster_auth_error('{"reason":"invalid_or_expired_token"}');
        expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();

        mockEmitted.length = 0;
        mockHandlers.connect();                     // a reconnect after the refusal
        expect(joins()).toEqual([]);
    });

    test('clears the markers instead of leaving them frozen at their last position', () => {
        const mod = loadAt('/caster?server=KTP%20-%20Test#caster_token=tok-expired');
        mod.useHudStore.getState().setAlliesPlayers([{ user_id: 'p_a', pos: { x: 10, y: 20 } }]);
        mod.useHudStore.getState().setAxisPlayers([{ user_id: 'p_b', pos: { x: -5, y: 7 } }]);

        mockHandlers.caster_auth_error('{"reason":"invalid_or_expired_token"}');

        const { allies_players, axis_players } = mod.useHudStore.getState();
        expect(allies_players[0].pos).toBeNull();
        expect(axis_players[0].pos).toBeNull();
    });
});

describe('setCasterSession', () => {
    test('clearing the session leaves the room it was in', () => {
        const mod = loadAt('/caster?server=KTP%20-%20Test#caster_token=tok-frag');
        mod.setCasterSession(null, null);
        expect(leaves()).toEqual(['KTP - Test']);
    });

    test('switching server leaves the old room and joins the new one', () => {
        const mod = loadAt('/caster?server=KTP%20-%20Test#caster_token=tok-frag');
        mockEmitted.length = 0;
        mod.setCasterSession('KTP - Other', 'tok-frag');
        expect(leaves()).toEqual(['KTP - Test']);
        expect(joins()).toEqual([{ server: 'KTP - Other', token: 'tok-frag' }]);
    });
});
