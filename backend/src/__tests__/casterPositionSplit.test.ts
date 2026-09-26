/**
 * The one thing the 2026-09-25 access-control change actually has to get
 * right: positions leave `player_state` before it reaches the public,
 * unauthenticated `server:${server}` room (the one `/screen` also joins),
 * and go out ONLY on `caster:${server}` as a separate `player_positions`
 * event. Getting this backwards silently re-opens the exact leak the
 * change exists to close, with no user-visible symptom that would catch it.
 */
import { Server as SocketServer } from 'socket.io';
import { createServer } from 'http';
import { makeFireToSockets } from '../handler/ingest';
import config from '../config';

function emitsOn(io: SocketServer) {
    const calls: { room: string; event: string; payload: any }[] = [];
    jest.spyOn(io, 'to').mockImplementation(((room: string) => ({
        emit: (event: string, payload: string) => {
            calls.push({ room, event, payload: JSON.parse(payload) });
        },
    })) as any);
    return calls;
}

describe('makeFireToSockets — player_state position split', () => {
    let io: SocketServer;
    // The split is opt-in (caster_auth.gate_positions). These cases describe
    // the ON behaviour; the OFF suite at the bottom pins that the default
    // changes nothing at all.
    beforeEach(() => {
        io = new SocketServer(createServer());
        config.caster_auth.gate_positions = true;
    });
    afterEach(() => {
        io.close();
        config.caster_auth.gate_positions = false;
    });

    const PLAYER_STATE = {
        event: 'player_state',
        players: [
            { user_id: 'STEAM_0:1:1', weapon: 'garand', nades: 2, x: 100, y: -200 },
            { user_id: 'STEAM_0:1:2', weapon: 'kar', nades: 1, x: 0, y: 0 }, // unreadable origin
        ],
    };

    it('never puts x/y on the public server room', () => {
        const calls = emitsOn(io);
        makeFireToSockets(io)('server-a', undefined, PLAYER_STATE);

        const publicCall = calls.find(c => c.room === 'server:server-a');
        expect(publicCall).toBeDefined();
        expect(publicCall!.event).toBe('player_state');
        for (const p of publicCall!.payload.players) {
            expect(p).not.toHaveProperty('x');
            expect(p).not.toHaveProperty('y');
        }
    });

    it('keeps every non-position field on the public payload, unchanged', () => {
        const calls = emitsOn(io);
        makeFireToSockets(io)('server-a', undefined, PLAYER_STATE);

        const publicPlayers = calls.find(c => c.room === 'server:server-a')!.payload.players;
        expect(publicPlayers).toEqual([
            { user_id: expect.any(String), weapon: 'garand', nades: 2 },
            { user_id: expect.any(String), weapon: 'kar', nades: 1 },
        ]);
    });

    it('sends positions ONLY to the caster room, as player_positions', () => {
        const calls = emitsOn(io);
        makeFireToSockets(io)('server-a', undefined, PLAYER_STATE);

        const casterCalls = calls.filter(c => c.room === 'caster:server-a');
        expect(casterCalls).toHaveLength(1);
        expect(casterCalls[0].event).toBe('player_positions');
        expect(casterCalls[0].payload.players).toEqual([
            { user_id: expect.any(String), x: 100, y: -200 },
        ]);

        // The (0,0) "unreadable origin" player never appears in the caster feed either —
        // it is exactly as absent there as a real position would make it present.
        expect(casterCalls[0].payload.players).toHaveLength(1);
    });

    it('sends nothing to the caster room when nobody has a readable position', () => {
        const calls = emitsOn(io);
        makeFireToSockets(io)('server-a', undefined, {
            event: 'player_state',
            players: [{ user_id: 'STEAM_0:1:1', weapon: 'garand', nades: 2, x: 0, y: 0 }],
        });

        expect(calls.some(c => c.room === 'caster:server-a')).toBe(false);
    });

    it('leaves every other event type going out exactly as before — no caster room, no split', () => {
        const calls = emitsOn(io);
        makeFireToSockets(io)('server-a', undefined, { event: 'kill', killer_id: 'STEAM_0:1:1', victim_id: 'STEAM_0:1:2' });

        expect(calls.some(c => c.room === 'caster:server-a')).toBe(false);
        const publicCall = calls.find(c => c.room === 'server:server-a');
        expect(publicCall!.event).toBe('kill');
        expect(publicCall!.payload).toHaveProperty('killer_id');
    });
});

describe('makeFireToSockets — gate_positions OFF is the untouched status quo', () => {
    let io: SocketServer;
    beforeEach(() => {
        io = new SocketServer(createServer());
        config.caster_auth.gate_positions = false; // the default
    });
    afterEach(() => { io.close(); });

    const PLAYER_STATE = {
        event: 'player_state',
        players: [{ user_id: 'STEAM_0:1:1', weapon: 'garand', nades: 2, x: 100, y: -200 }],
    };

    it('leaves x/y on the public payload, exactly as before the split existed', () => {
        const calls = emitsOn(io);
        makeFireToSockets(io)('server-a', undefined, PLAYER_STATE);

        const publicCall = calls.find(c => c.room === 'server:server-a');
        expect(publicCall!.event).toBe('player_state');
        expect(publicCall!.payload.players[0]).toEqual(
            expect.objectContaining({ x: 100, y: -200, weapon: 'garand', nades: 2 }),
        );
    });

    it('emits nothing at all to the caster room', () => {
        const calls = emitsOn(io);
        makeFireToSockets(io)('server-a', undefined, PLAYER_STATE);
        expect(calls.some(c => c.room === 'caster:server-a')).toBe(false);
    });

    it('still reaches every room the old fan-out did', () => {
        const calls = emitsOn(io);
        makeFireToSockets(io)('server-a', 'match-1', PLAYER_STATE);
        const rooms = calls.map(c => c.room);
        expect(rooms).toEqual(
            expect.arrayContaining(['match-1', 'server:server-a', 'all', 'hud_socket']),
        );
    });
});
