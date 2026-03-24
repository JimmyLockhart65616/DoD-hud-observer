import config from '../../config.json';
import express from 'express';
import path from 'path';
import cors from 'cors';
import { io } from 'socket.io-client';
import socketio from './socket/socket';
import { PluginServer } from './handler/server';

// Init internal Socket.IO server (backend ↔ frontend relay)
socketio.listen(config.INTERNAL_SOCKET_PORT);

// Connect backend process to internal socket
const internalSocket = io(`http://localhost:${config.INTERNAL_SOCKET_PORT}`);
internalSocket.emit('backend_connect');

// Import API router
import apiRouter from './routes/apiRouter';

// Init express
const app = express();

app.use('/assets', express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ limit: '50mb', extended: false }));
app.use(express.json({ limit: '50mb' }));
app.set('json spaces', 2);
app.disable('x-powered-by');
app.use(cors());
app.use('/api', apiRouter);

app.listen(config.backend.TCP_LOCAL_PORT, () => {
    console.log(`[api] REST server started on port ${config.backend.TCP_LOCAL_PORT}`);
});

/**
 * Start TCP server for AMXX plugin connections.
 * The plugin connects inbound from the game server to this backend.
 */
const { PLUGIN_TCP_PORT, PLUGIN_TOKEN } = config.backend;
const pluginServer = new PluginServer(PLUGIN_TCP_PORT, PLUGIN_TOKEN, internalSocket);

pluginServer.on('game_connected',    ()   => internalSocket.emit('game_connected', true));
pluginServer.on('game_authed',       (ok) => internalSocket.emit('game_authed', ok));
pluginServer.on('game_disconnected', ()   => internalSocket.emit('game_connected', false));

pluginServer.listen();
