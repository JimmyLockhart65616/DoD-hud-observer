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

// KTPMatchHandler MATCH_TYPE enum (KTPMatchHandler.sma:84):
//   0=COMPETITIVE, 1=SCRIM, 2=12MAN, 3=DRAFT, 4=KTP_OT, 5=DRAFT_OT
// OT matches get half >= 101 (regulation is 1 or 2).
describe('POST /ingest — match type coverage', () => {
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

    it.each([
        { name: 'competitive', match_type: 0, half: 1   },
        { name: 'scrim',       match_type: 1, half: 1   },
        { name: '12man',       match_type: 2, half: 1   },
        { name: 'draft',       match_type: 3, half: 1   },
        { name: 'ktpOT',       match_type: 4, half: 101 },
        { name: 'draftOT',     match_type: 5, half: 101 },
    ])('records a $name match end-to-end (type=$match_type, half=$half)', async ({ match_type, half }) => {
        const matchId = `KTP-type${match_type}-h${half}`;

        await request(app).post('/ingest').set('X-Auth-Key', 'key')
            .send({ event: 'ktp_match_start', match_id: matchId, map: 'dod_anzio', match_type, half });
        await request(app).post('/ingest').set('X-Auth-Key', 'key')
            .send({ event: 'half_start', match_id: matchId, half, timeleft: 1200 });
        await request(app).post('/ingest').set('X-Auth-Key', 'key')
            .send({ event: 'kill', match_id: matchId, killer_id: 'STEAM_0:0:1', victim_id: 'STEAM_0:0:2', weapon: 'garand' });
        await request(app).post('/ingest').set('X-Auth-Key', 'key')
            .send({ event: 'flag_captured', match_id: matchId, flag_id: 0, new_owner: 'allies' });
        await request(app).post('/ingest').set('X-Auth-Key', 'key')
            .send({ event: 'ktp_match_end', match_id: matchId, allies_score: 3, axis_score: 2 });

        const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, matchId, 'metadata.json'), 'utf-8'));
        expect(meta.matchType).toBe(match_type);
        expect(meta.half).toBe(half);
        expect(meta.map).toBe('dod_anzio');
        expect(meta.endedAt).not.toBeNull();
        expect(meta.eventCount).toBe(5);

        const jsonl = fs.readFileSync(path.join(tmpDir, matchId, 'events.jsonl'), 'utf-8');
        const events = jsonl.trim().split('\n').map(l => JSON.parse(l));
        expect(events.map(e => e.event)).toEqual([
            'ktp_match_start', 'half_start', 'kill', 'flag_captured', 'ktp_match_end',
        ]);
        // ktp_match_end must be persisted itself — this closes a gap where the recorder
        // could conceivably clear state before writing the final event.
        expect(events[events.length - 1]).toMatchObject({
            event: 'ktp_match_end',
            allies_score: 3,
            axis_score: 2,
        });
    });
});

describe('POST /ingest — match isolation & edge cases', () => {
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

    it('keeps back-to-back matches isolated in separate directories', async () => {
        const m1 = 'KTP-back2back-A';
        const m2 = 'KTP-back2back-B';

        await request(app).post('/ingest').set('X-Auth-Key', 'key')
            .send({ event: 'ktp_match_start', match_id: m1, map: 'dod_anzio', match_type: 1, half: 1 });
        await request(app).post('/ingest').set('X-Auth-Key', 'key')
            .send({ event: 'kill', match_id: m1, killer_id: 'STEAM_0:0:A', victim_id: 'STEAM_0:0:B', weapon: 'garand' });
        await request(app).post('/ingest').set('X-Auth-Key', 'key')
            .send({ event: 'ktp_match_end', match_id: m1, allies_score: 1, axis_score: 0 });

        await request(app).post('/ingest').set('X-Auth-Key', 'key')
            .send({ event: 'ktp_match_start', match_id: m2, map: 'dod_flash', match_type: 2, half: 1 });
        await request(app).post('/ingest').set('X-Auth-Key', 'key')
            .send({ event: 'kill', match_id: m2, killer_id: 'STEAM_0:0:C', victim_id: 'STEAM_0:0:D', weapon: 'mp40' });
        await request(app).post('/ingest').set('X-Auth-Key', 'key')
            .send({ event: 'ktp_match_end', match_id: m2, allies_score: 0, axis_score: 1 });

        const meta1 = JSON.parse(fs.readFileSync(path.join(tmpDir, m1, 'metadata.json'), 'utf-8'));
        const meta2 = JSON.parse(fs.readFileSync(path.join(tmpDir, m2, 'metadata.json'), 'utf-8'));
        expect(meta1.map).toBe('dod_anzio');
        expect(meta1.matchType).toBe(1);
        expect(meta2.map).toBe('dod_flash');
        expect(meta2.matchType).toBe(2);

        const events1 = fs.readFileSync(path.join(tmpDir, m1, 'events.jsonl'), 'utf-8')
            .trim().split('\n').map(l => JSON.parse(l));
        const events2 = fs.readFileSync(path.join(tmpDir, m2, 'events.jsonl'), 'utf-8')
            .trim().split('\n').map(l => JSON.parse(l));

        // No cross-contamination: each match's events.jsonl only has its own events.
        expect(events1.every(e => e.match_id === m1)).toBe(true);
        expect(events2.every(e => e.match_id === m2)).toBe(true);
        expect(events1).toHaveLength(3);
        expect(events2).toHaveLength(3);
    });

    it('preserves metadata on a duplicate ktp_match_start (start rejected, event still logged)', async () => {
        const matchId = 'KTP-dup';

        await request(app).post('/ingest').set('X-Auth-Key', 'key')
            .send({ event: 'ktp_match_start', match_id: matchId, map: 'dod_anzio', match_type: 1, half: 1 });
        await request(app).post('/ingest').set('X-Auth-Key', 'key')
            .send({ event: 'kill', match_id: matchId, killer_id: 'STEAM_0:0:1', victim_id: 'STEAM_0:0:2', weapon: 'garand' });

        // Duplicate start with different map/type — startMatch rejects via activeMatches
        // check, so metadata.json stays on the first values. The event itself still gets
        // appended to events.jsonl (recordEvent runs unconditionally post-routing).
        await request(app).post('/ingest').set('X-Auth-Key', 'key')
            .send({ event: 'ktp_match_start', match_id: matchId, map: 'dod_flash', match_type: 3, half: 2 });

        const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, matchId, 'metadata.json'), 'utf-8'));
        expect(meta.map).toBe('dod_anzio');
        expect(meta.matchType).toBe(1);
        expect(meta.half).toBe(1);

        const events = fs.readFileSync(path.join(tmpDir, matchId, 'events.jsonl'), 'utf-8')
            .trim().split('\n').filter(l => l).map(l => JSON.parse(l));
        expect(events).toHaveLength(3);
        expect(events[0].event).toBe('ktp_match_start');
        expect(events[0].map).toBe('dod_anzio');
        expect(events[1].event).toBe('kill');
        expect(events[2].event).toBe('ktp_match_start');
        expect(events[2].map).toBe('dod_flash');  // dup body preserved in log
    });
});
