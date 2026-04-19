/**
 * Ingest route tests
 *
 * Tests HTTP POST /ingest auth validation and event dispatch.
 * Uses express directly without starting a real server.
 */
import express, { Application } from 'express';
import request from 'supertest';
import { createIngestRouter } from '../handler/ingest';
import { MatchRecorder } from '../handler/matchRecorder';
import { MetricsCollector } from '../handler/metrics';
import { Server as SocketServer } from 'socket.io';
import { createServer } from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';

// supertest types
import 'jest';

function makeTmpDir(): string {
    const dir = path.join(os.tmpdir(), `hud-test-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function makeApp(authKey: string, recorder: MatchRecorder, io: SocketServer): Application {
    const app = express();
    app.use(express.json());
    const metrics = new MetricsCollector();
    app.use('/ingest', createIngestRouter(authKey, recorder, io, metrics));
    return app;
}

describe('POST /ingest — auth', () => {
    let tmpDir: string;
    let recorder: MatchRecorder;
    let io: SocketServer;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        recorder = new MatchRecorder(tmpDir);
        io = new SocketServer(createServer());
    });

    afterEach(() => {
        recorder.close();
        io.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns 401 with no X-Auth-Key header', async () => {
        const app = makeApp('secret', recorder, io);
        const res = await request(app)
            .post('/ingest')
            .send({ event: 'test' });
        expect(res.status).toBe(401);
    });

    it('returns 401 with wrong X-Auth-Key', async () => {
        const app = makeApp('secret', recorder, io);
        const res = await request(app)
            .post('/ingest')
            .set('X-Auth-Key', 'wrong')
            .send({ event: 'test' });
        expect(res.status).toBe(401);
    });

    it('returns 400 when body has no event field', async () => {
        const app = makeApp('secret', recorder, io);
        const res = await request(app)
            .post('/ingest')
            .set('X-Auth-Key', 'secret')
            .send({ not_an_event: true });
        expect(res.status).toBe(400);
    });

    it('returns 200 with correct key and valid event', async () => {
        const app = makeApp('secret', recorder, io);
        const res = await request(app)
            .post('/ingest')
            .set('X-Auth-Key', 'secret')
            .send({ event: 'round_start', match_id: 'KTP-abc', timeleft: 1200 });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
    });
});

describe('POST /ingest — match lifecycle', () => {
    let tmpDir: string;
    let recorder: MatchRecorder;
    let io: SocketServer;
    let app: Application;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        recorder = new MatchRecorder(tmpDir);
        io = new SocketServer(createServer());
        app = makeApp('key', recorder, io);
    });

    afterEach(() => {
        recorder.close();
        io.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('creates match files on ktp_match_start', async () => {
        await request(app)
            .post('/ingest')
            .set('X-Auth-Key', 'key')
            .send({ event: 'ktp_match_start', match_id: 'KTP-m1', map: 'dod_anzio', match_type: 1, half: 1 });

        expect(fs.existsSync(path.join(tmpDir, 'KTP-m1', 'metadata.json'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, 'KTP-m1', 'events.jsonl'))).toBe(true);
    });

    it('appends events to events.jsonl', async () => {
        const matchId = 'KTP-m2';
        await request(app).post('/ingest').set('X-Auth-Key', 'key')
            .send({ event: 'ktp_match_start', match_id: matchId, map: 'dod_flash', match_type: 1, half: 1 });
        await request(app).post('/ingest').set('X-Auth-Key', 'key')
            .send({ event: 'round_start', match_id: matchId, timeleft: 1200 });
        await request(app).post('/ingest').set('X-Auth-Key', 'key')
            .send({ event: 'kill', match_id: matchId, killer_id: 'STEAM_0:0:1', victim_id: 'STEAM_0:0:2', weapon: 'garand' });

        const jsonl = fs.readFileSync(path.join(tmpDir, matchId, 'events.jsonl'), 'utf-8');
        const lines = jsonl.trim().split('\n').filter(l => l);
        expect(lines).toHaveLength(3);
        expect(JSON.parse(lines[0]).event).toBe('ktp_match_start');
        expect(JSON.parse(lines[1]).event).toBe('round_start');
        expect(JSON.parse(lines[2]).event).toBe('kill');
    });

    it('finalizes metadata.json with eventCount on ktp_match_end', async () => {
        const matchId = 'KTP-m3';
        await request(app).post('/ingest').set('X-Auth-Key', 'key')
            .send({ event: 'ktp_match_start', match_id: matchId, map: 'dod_anzio', match_type: 1, half: 1 });
        await request(app).post('/ingest').set('X-Auth-Key', 'key')
            .send({ event: 'round_start', match_id: matchId, timeleft: 1200 });
        await request(app).post('/ingest').set('X-Auth-Key', 'key')
            .send({ event: 'ktp_match_end', match_id: matchId });

        const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, matchId, 'metadata.json'), 'utf-8'));
        expect(meta.endedAt).not.toBeNull();
        expect(meta.eventCount).toBe(3);  // start + round_start + end
    });
});
