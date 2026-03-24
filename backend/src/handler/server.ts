import net from 'net';
import { EventEmitter } from 'events';
import { Socket as IOSocket } from 'socket.io-client';

/**
 * PluginServer
 *
 * Listens for inbound TCP connections from the DoD AMXX plugin.
 * The plugin connects out from the game server to this backend.
 *
 * Protocol:
 *   1. Plugin connects and sends:  "Bearer <token>\n"
 *   2. We validate token and begin accepting newline-delimited JSON events.
 */
export class PluginServer extends EventEmitter {

    private server: net.Server;
    private io: IOSocket;
    private token: string;
    private port: number;
    private client: net.Socket | null = null;
    private connected: boolean = false;
    private authed: boolean = false;

    constructor(port: number, token: string, socketio: IOSocket) {
        super();
        this.port  = port;
        this.token = token;
        this.io    = socketio;

        this.server = net.createServer((socket) => {
            console.log(`[plugin] Game server connected from ${socket.remoteAddress}:${socket.remotePort}`);

            // Only allow one active connection
            if (this.client) {
                console.log('[plugin] Replacing previous connection');
                this.client.destroy();
            }

            this.client    = socket;
            this.connected = true;
            this.authed    = false;
            this.emit('game_connected');

            this._setupClient(socket);
        });
    }

    listen() {
        this.server.listen(this.port, '0.0.0.0', () => {
            console.log(`[plugin] TCP server listening on port ${this.port}`);
        });
    }

    isConnected()  { return this.connected; }
    isAuthed()     { return this.authed; }

    private _setupClient(socket: net.Socket) {
        let buffer = '';

        socket.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf-8');

            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                // First message must be auth
                if (!this.authed) {
                    if (trimmed === `Bearer ${this.token}`) {
                        this.authed = true;
                        console.log('[plugin] Auth: success');
                        this.emit('game_authed', true);
                    } else {
                        console.warn('[plugin] Auth: failed (bad token)');
                        this.emit('game_authed', false);
                        socket.destroy();
                    }
                    continue;
                }

                try {
                    const data = JSON.parse(trimmed);
                    console.log('[plugin] event:', data.event, data);
                    this.io.emit(data.event, JSON.stringify(data));
                } catch (err) {
                    console.warn('[plugin] Failed to parse line:', trimmed);
                }
            }
        });

        socket.on('error', (err) => {
            console.error('[plugin] Connection error:', err.message);
        });

        socket.on('close', () => {
            console.log('[plugin] Game server disconnected');
            this.connected = false;
            this.authed    = false;
            this.client    = null;
            this.emit('game_disconnected');
        });
    }
}
