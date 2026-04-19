import { Server } from 'socket.io';
import { createServer } from 'http';
import { MatchRecorder } from '../handler/matchRecorder';
import { getServerSnapshot } from '../handler/ingest';

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

    const io = new Server(httpServer, {
        cors: {
            origin,
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

            // Replay cached state so late joiners see current game state
            const snapshot = getServerSnapshot(serverName);
            for (const raw of snapshot) {
                const parsed = JSON.parse(raw);
                socket.emit(parsed.event, raw);
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
