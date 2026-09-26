import { Server } from 'socket.io';
import { createServer } from 'http';
import { MatchRecorder } from '../handler/matchRecorder';
import { getServerSnapshot } from '../handler/ingest';
import { pseudonymize } from '../handler/pseudonym';
import { verifyToken } from '../handler/casterAuth';

/**
 * Creates a Socket.IO server with match-based room routing.
 *
 * Clients join a room by emitting 'join_match' with a matchId.
 * They can also join the 'all' room to receive events from every active match.
 *
 * The ingest route pushes events into rooms directly via io.to(matchId).emit().
 * This module only handles client connection/room management.
 */
export function createSocketServer(origin: string, recorder: MatchRecorder) {
    const httpServer = createServer();

    // frontend.origin may be a comma-separated list so several serving origins
    // can share one backend during a URL migration (e.g. the new
    // https://hud.ktpdod.com single-origin proxy AND the legacy
    // http://<ip>:3000 that existing OBS sources still point at). credentials:true
    // forbids a wildcard, so we pass the explicit allow-list to Socket.IO (it
    // accepts a string or string[]). Single value → plain string (unchanged).
    const allowedOrigins = origin.split(',').map((s) => s.trim()).filter(Boolean);

    const io = new Server(httpServer, {
        cors: {
            origin: allowedOrigins.length <= 1 ? (allowedOrigins[0] ?? origin) : allowedOrigins,
            methods: ['GET', 'POST'],
            credentials: true,
        },
    });

    io.on('connection', (socket) => {
        console.log(`[socket] Client connected: ${socket.id}`);

        // Client requests to watch a specific match
        socket.on('join_match', (matchId: string) => {
            socket.join(matchId);
            console.log(`[socket] ${socket.id} joined room ${matchId}`);

            // Send current match metadata if available
            const meta = recorder.getMetadata(matchId);
            if (meta) {
                socket.emit('match_metadata', JSON.stringify(meta));
            }
        });

        // Client requests to leave a match room
        socket.on('leave_match', (matchId: string) => {
            socket.leave(matchId);
            console.log(`[socket] ${socket.id} left room ${matchId}`);
        });

        // Client requests to watch all matches (dashboard mode)
        socket.on('join_all', () => {
            socket.join('all');
            console.log(`[socket] ${socket.id} joined room 'all'`);
        });

        // Client requests to watch a specific game server (pre-match or live)
        socket.on('join_server', (serverName: string) => {
            socket.join(`server:${serverName}`);
            console.log(`[socket] ${socket.id} joined server room server:${serverName}`);

            // Replay cached state so late joiners see current game state.
            //
            // This is a SECOND publication boundary and it does not go through
            // makeFireToSockets — the snapshot is read straight out of the state
            // cache, which holds real SteamIDs on purpose. Pseudonymize here or
            // every overlay reload and every /caster open leaks the roster, which
            // is the single most-hit join path we have.
            const snapshot = getServerSnapshot(serverName);
            for (const raw of snapshot) {
                const parsed = pseudonymize(JSON.parse(raw), serverName);
                socket.emit(parsed.event, JSON.stringify(parsed));
            }
            if (snapshot.length > 0) {
                console.log(`[socket] Replayed ${snapshot.length} cached events to ${socket.id}`);
            }
        });

        // Client requests to leave a server room
        socket.on('leave_server', (serverName: string) => {
            socket.leave(`server:${serverName}`);
            console.log(`[socket] ${socket.id} left server room server:${serverName}`);
        });

        // Caster-only: join the room that carries live positions
        // ('player_positions', see makeFireToSockets in ingest.ts). Gated on a
        // session token from /api/caster-auth/login -- `server:${serverName}`
        // above stays unauthenticated for /screen and everything else, and
        // never carries positions. No snapshot replay here (unlike
        // join_server): the next player_state tick is at most 250ms away at
        // this feed's 4 Hz, which is not worth a second state-cache read for.
        socket.on('join_caster', (payload: { server?: string; token?: string }) => {
            const username = verifyToken(payload?.token);
            if (!username) {
                socket.emit('caster_auth_error', JSON.stringify({ reason: 'invalid_or_expired_token' }));
                return;
            }
            const serverName = payload?.server;
            if (!serverName) return;
            socket.join(`caster:${serverName}`);
            console.log(`[socket] ${socket.id} joined caster room caster:${serverName} as ${username}`);
        });

        socket.on('leave_caster', (serverName: string) => {
            socket.leave(`caster:${serverName}`);
            console.log(`[socket] ${socket.id} left caster room caster:${serverName}`);
        });

        // Legacy: frontend emits 'hud_socket' to join — bridge to default match
        socket.on('hud_socket', () => {
            socket.join('hud_socket');
            console.log(`[socket] ${socket.id} joined legacy 'hud_socket' room`);
        });

        // List active matches
        socket.on('list_matches', () => {
            const active = recorder.getActiveMatchIds();
            const all = recorder.getAllMetadata();
            socket.emit('match_list', JSON.stringify({ active, matches: all }));
        });

        socket.on('disconnect', () => {
            console.log(`[socket] Client disconnected: ${socket.id}`);
        });
    });

    return { httpServer, io };
}
