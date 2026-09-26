/**
 * join_caster is the gate on the ONE room that carries live positions
 * (`caster:${server}`, see makeFireToSockets / casterPositionSplit.test.ts).
 * If a bad or missing token were ever let through here, the position split
 * on the ingest side would be entirely decorative — anyone could just ask
 * for the caster room directly over a raw socket connection.
 */
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { Server as SocketServer } from 'socket.io';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createSocketServer } from '../socket/socket';
import { MatchRecorder } from '../handler/matchRecorder';
import { issueToken } from '../handler/casterAuth';

function makeTmpDir(): string {
    const dir = path.join(os.tmpdir(), `hud-caster-socket-test-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

async function connect(port: number): Promise<ClientSocket> {
    const client = ioClient(`http://localhost:${port}`, { transports: ['websocket'] });
    await new Promise<void>(resolve => client.on('connect', () => resolve()));
    return client;
}

describe('join_caster', () => {
    let tmpDir: string;
    let recorder: MatchRecorder;
    let httpServer: ReturnType<typeof createServer>;
    let io: SocketServer;
    let port: number;

    beforeEach(async () => {
        tmpDir = makeTmpDir();
        recorder = new MatchRecorder(tmpDir);
        ({ httpServer, io } = createSocketServer('*', recorder));
        await new Promise<void>(resolve => httpServer.listen(0, resolve));
        port = (httpServer.address() as AddressInfo).port;
    });

    afterEach(() => {
        recorder.close();
        io.close();
        httpServer.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('refuses a missing token', async () => {
        const client = await connect(port);
        const error = new Promise<any>(resolve => client.on('caster_auth_error', (raw: string) => resolve(JSON.parse(raw))));
        client.emit('join_caster', { server: 'KTP - Test' });
        await expect(error).resolves.toEqual({ reason: 'invalid_or_expired_token' });
        client.close();
    });

    it('refuses a forged token', async () => {
        const client = await connect(port);
        const error = new Promise<any>(resolve => client.on('caster_auth_error', (raw: string) => resolve(JSON.parse(raw))));
        client.emit('join_caster', { server: 'KTP - Test', token: 'not.avalidtoken' });
        await expect(error).resolves.toEqual({ reason: 'invalid_or_expired_token' });
        client.close();
    });

    it('does not join the caster room on a bad token', async () => {
        const client = await connect(port);
        const gotError = new Promise<void>(resolve => client.on('caster_auth_error', () => resolve()));
        client.emit('join_caster', { server: 'KTP - Test', token: 'garbage' });
        await gotError;

        const received: string[] = [];
        client.on('probe', (raw: string) => received.push(raw));
        io.to('caster:KTP - Test').emit('probe', 'should-not-arrive');
        await new Promise(resolve => setTimeout(resolve, 200));

        expect(received).toHaveLength(0);
        client.close();
    });

    it('joins the caster room on a valid token, and only that server\'s room', async () => {
        const client = await connect(port);
        const token = issueToken({ id: '123456789', name: 'coreymarko' });
        client.emit('join_caster', { server: 'KTP - Test', token });
        // No caster_auth_error should fire; give the join a moment to land.
        await new Promise(resolve => setTimeout(resolve, 200));

        const received: string[] = [];
        client.on('probe', (raw: string) => received.push(raw));
        io.to('caster:KTP - Test').emit('probe', 'for-this-server');
        io.to('caster:KTP - Other').emit('probe', 'for-a-different-server');
        await new Promise(resolve => setTimeout(resolve, 200));

        expect(received).toEqual(['for-this-server']);
        client.close();
    });

    it('leave_caster actually leaves the room', async () => {
        const client = await connect(port);
        const token = issueToken({ id: '123456789', name: 'coreymarko' });
        client.emit('join_caster', { server: 'KTP - Test', token });
        await new Promise(resolve => setTimeout(resolve, 200));
        client.emit('leave_caster', 'KTP - Test');
        await new Promise(resolve => setTimeout(resolve, 200));

        const received: string[] = [];
        client.on('probe', (raw: string) => received.push(raw));
        io.to('caster:KTP - Test').emit('probe', 'after-leaving');
        await new Promise(resolve => setTimeout(resolve, 200));

        expect(received).toHaveLength(0);
        client.close();
    });
});
