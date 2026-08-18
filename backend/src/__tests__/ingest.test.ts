/**
 * Ingest route tests
 *
 * Tests HTTP POST /ingest auth validation and event dispatch.
 * Uses express directly without starting a real server.
 */
import express, { Application } from 'express';
import request from 'supertest';
import { createIngestRouter, getServerPlayerCount, getServerSnapshot, makeFireToSockets } from '../handler/ingest';
import { MatchRecorder } from '../handler/matchRecorder';
import { MetricsCollector } from '../handler/metrics';
import { HltvSyncService } from '../handler/hltvSync';
import { HltvDelayBuffer } from '../handler/hltvDelayBuffer';
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
            .send({ event: 'team_score', match_id: 'KTP-abc', allies_score: 0, axis_score: 0 });
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
            .send({ event: 'half_start', match_id: matchId, half: 1, timeleft: 1200 });
        await request(app).post('/ingest').set('X-Auth-Key', 'key')
            .send({ event: 'kill', match_id: matchId, killer_id: 'STEAM_0:0:1', victim_id: 'STEAM_0:0:2', weapon: 'garand' });

        const jsonl = fs.readFileSync(path.join(tmpDir, matchId, 'events.jsonl'), 'utf-8');
        const lines = jsonl.trim().split('\n').filter(l => l);
        expect(lines).toHaveLength(3);
        expect(JSON.parse(lines[0]).event).toBe('ktp_match_start');
        expect(JSON.parse(lines[1]).event).toBe('half_start');
        expect(JSON.parse(lines[2]).event).toBe('kill');
    });

    it('finalizes metadata.json with eventCount on ktp_match_end', async () => {
        const matchId = 'KTP-m3';
        await request(app).post('/ingest').set('X-Auth-Key', 'key')
            .send({ event: 'ktp_match_start', match_id: matchId, map: 'dod_anzio', match_type: 1, half: 1 });
        await request(app).post('/ingest').set('X-Auth-Key', 'key')
            .send({ event: 'half_start', match_id: matchId, half: 1, timeleft: 1200 });
        await request(app).post('/ingest').set('X-Auth-Key', 'key')
            .send({ event: 'ktp_match_end', match_id: matchId });

        const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, matchId, 'metadata.json'), 'utf-8'));
        expect(meta.endedAt).not.toBeNull();
        expect(meta.eventCount).toBe(3);  // start + half_start + end
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

describe('player_score obj_score round-trip', () => {
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

    async function post(body: Record<string, unknown>, hostname: string): Promise<void> {
        await request(app)
            .post('/ingest')
            .set('X-Auth-Key', 'key')
            .set('X-Server-Hostname', hostname)
            .send(body);
    }

    it('persists obj_score from player_score and replays it in the snapshot', async () => {
        const host = 'KTP - Obj Test';
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:1', name: 'Captor', team: 'allies' }, host);
        await post({
            event: 'player_score',
            user_id: 'STEAM_0:0:1',
            kills: 2, deaths: 1, score: 7, obj_score: 5,
        }, host);

        const snapshot = getServerSnapshot(host).map(s => JSON.parse(s));
        const replayed = snapshot.find(e => e.event === 'player_score' && e.user_id === 'STEAM_0:0:1');
        expect(replayed).toMatchObject({
            event: 'player_score',
            user_id: 'STEAM_0:0:1',
            kills: 2, deaths: 1, score: 7, obj_score: 5,
        });
    });

    it('defaults obj_score to 0 when the field is absent (backward compat)', async () => {
        const host = 'KTP - Obj Compat';
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:2', name: 'Old', team: 'axis' }, host);
        await post({
            event: 'player_score',
            user_id: 'STEAM_0:0:2',
            kills: 1, deaths: 0, score: 1,
        }, host);

        const snapshot = getServerSnapshot(host).map(s => JSON.parse(s));
        const replayed = snapshot.find(e => e.event === 'player_score' && e.user_id === 'STEAM_0:0:2');
        expect(replayed).toMatchObject({
            user_id: 'STEAM_0:0:2',
            kills: 1, deaths: 0, score: 1, obj_score: 0,
        });
    });

    it('resets obj_score to 0 on half_start', async () => {
        const host = 'KTP - Obj HalfReset';
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:3', name: 'Halfer', team: 'allies' }, host);
        await post({
            event: 'player_score',
            user_id: 'STEAM_0:0:3',
            kills: 4, deaths: 2, score: 14, obj_score: 10,
        }, host);
        await post({ event: 'half_start', half: 2, timeleft: 1200 }, host);

        const snapshot = getServerSnapshot(host).map(s => JSON.parse(s));
        const replayed = snapshot.find(e => e.event === 'player_score' && e.user_id === 'STEAM_0:0:3');
        expect(replayed).toMatchObject({
            user_id: 'STEAM_0:0:3',
            kills: 0, deaths: 0, score: 0, obj_score: 0,
        });
    });
});

describe('stats fields round-trip (player_score extension + player_stats_summary)', () => {
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

    async function post(body: Record<string, unknown>, hostname: string): Promise<void> {
        await request(app)
            .post('/ingest')
            .set('X-Auth-Key', 'key')
            .set('X-Server-Hostname', hostname)
            .send(body);
    }

    const STATS = { damage: 240, assists: 2, hs_kills: 1, nade_kills: 1, gun_kills: 2, hits: 9, hs_hits: 2, caps: 3, cap_breaks: 2, best_streak: 4 };

    it('replays extended player_score stat fields in the snapshot', async () => {
        const host = 'KTP - Stats RT';
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:10', name: 'Statser', team: 'allies' }, host);
        await post({ event: 'player_score', user_id: 'STEAM_0:0:10', kills: 3, deaths: 1, score: 9, obj_score: 0, ...STATS }, host);

        const snapshot = getServerSnapshot(host).map(s => JSON.parse(s));
        const replayed = snapshot.find(e => e.event === 'player_score' && e.user_id === 'STEAM_0:0:10');
        expect(replayed).toMatchObject({ kills: 3, deaths: 1, ...STATS });
    });

    it('defaults stat fields to 0 for old-plugin player_score events', async () => {
        const host = 'KTP - Stats Compat';
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:11', name: 'OldPlugin', team: 'axis' }, host);
        await post({ event: 'player_score', user_id: 'STEAM_0:0:11', kills: 1, deaths: 0, score: 1 }, host);

        const snapshot = getServerSnapshot(host).map(s => JSON.parse(s));
        const replayed = snapshot.find(e => e.event === 'player_score' && e.user_id === 'STEAM_0:0:11');
        expect(replayed).toMatchObject({
            kills: 1, damage: 0, assists: 0, hs_kills: 0, nade_kills: 0, gun_kills: 0, hits: 0, hs_hits: 0, caps: 0, cap_breaks: 0, best_streak: 0,
        });
    });

    it('zeroes stat fields on half_start', async () => {
        const host = 'KTP - Stats HalfReset';
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:12', name: 'Halfer', team: 'allies' }, host);
        await post({ event: 'player_score', user_id: 'STEAM_0:0:12', kills: 4, deaths: 2, score: 14, obj_score: 0, ...STATS }, host);
        await post({ event: 'half_start', half: 2, timeleft: 1200 }, host);

        const snapshot = getServerSnapshot(host).map(s => JSON.parse(s));
        const replayed = snapshot.find(e => e.event === 'player_score' && e.user_id === 'STEAM_0:0:12');
        expect(replayed).toMatchObject({
            kills: 0, damage: 0, assists: 0, hs_kills: 0, nade_kills: 0, gun_kills: 0, hits: 0, hs_hits: 0, caps: 0, cap_breaks: 0, best_streak: 0,
        });
    });

    it('merges player_stats_summary rows into the cache by user_id', async () => {
        const host = 'KTP - Summary Merge';
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:13', name: 'Merged', team: 'allies' }, host);
        await post({
            event: 'player_stats_summary', reason: 'round_end',
            players: [{ user_id: 'STEAM_0:0:13', name: 'Merged', team: 'allies', kills: 2, deaths: 1, obj_score: 5, ...STATS }],
        }, host);

        const snapshot = getServerSnapshot(host).map(s => JSON.parse(s));
        const replayed = snapshot.find(e => e.event === 'player_score' && e.user_id === 'STEAM_0:0:13');
        expect(replayed).toMatchObject({ kills: 2, deaths: 1, obj_score: 5, ...STATS });
    });

    it('replays the half_end summary to late joiners, and drops it on ktp_match_start', async () => {
        const host = 'KTP - Halftime Replay';
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:14', name: 'Half', team: 'axis' }, host);
        const summary = {
            event: 'player_stats_summary', reason: 'half_end',
            players: [{ user_id: 'STEAM_0:0:14', name: 'Half', team: 'axis', kills: 5, deaths: 3, obj_score: 0, ...STATS }],
        };
        await post(summary, host);

        let snapshot = getServerSnapshot(host).map(s => JSON.parse(s));
        const replayed = snapshot.find(e => e.event === 'player_stats_summary');
        expect(replayed).toMatchObject({ reason: 'half_end' });
        expect(replayed.players).toHaveLength(1);

        // A fresh half/match clears the cached board so it can't replay stale.
        await post({ event: 'ktp_match_start', match_id: 'KTP-half-replay-1', map: 'dod_anzio', match_type: 1, half: 2 }, host);
        snapshot = getServerSnapshot(host).map(s => JSON.parse(s));
        expect(snapshot.find(e => e.event === 'player_stats_summary')).toBeUndefined();
    });

    it('evicts the cached half_end summary on a half_start-only boundary (dropped ktp_match_start)', async () => {
        // Guards the path where the half-2 ktp_match_start POST is lost (or, in
        // the mocker, never sent) but half_start(half:2) arrives — without
        // eviction the stale half-1 board would replay over live half 2.
        const host = 'KTP - Halftime HalfStartEvict';
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:16', name: 'HalfOnly', team: 'allies' }, host);
        await post({
            event: 'player_stats_summary', reason: 'half_end',
            players: [{ user_id: 'STEAM_0:0:16', name: 'HalfOnly', team: 'allies', kills: 5, deaths: 3, obj_score: 0, ...STATS }],
        }, host);

        let snapshot = getServerSnapshot(host).map(s => JSON.parse(s));
        expect(snapshot.find(e => e.event === 'player_stats_summary')).toBeDefined();

        // half_start with NO preceding ktp_match_start must still evict the cache.
        await post({ event: 'half_start', half: 2, timeleft: 1200 }, host);
        snapshot = getServerSnapshot(host).map(s => JSON.parse(s));
        expect(snapshot.find(e => e.event === 'player_stats_summary')).toBeUndefined();
    });

    it('persists player_stats_summary and half_end to events.jsonl (not socket-only)', async () => {
        const host = 'KTP - Stats Disk';
        const matchId = 'KTP-stats-disk-1';
        await post({ event: 'ktp_match_start', match_id: matchId, map: 'dod_anzio', match_type: 1, half: 1 }, host);
        await post({ event: 'half_end', match_id: matchId, half: 1, allies_score: 2, axis_score: 1 }, host);
        await post({
            event: 'player_stats_summary', match_id: matchId, reason: 'half_end',
            players: [{ user_id: 'STEAM_0:0:15', name: 'Disk', team: 'allies', kills: 1, deaths: 0, obj_score: 0, ...STATS }],
        }, host);
        await post({ event: 'ktp_match_end', match_id: matchId }, host);

        const events = fs.readFileSync(path.join(tmpDir, matchId, 'events.jsonl'), 'utf-8')
            .trim().split('\n').filter(l => l).map(l => JSON.parse(l));
        expect(events.map(e => e.event)).toEqual(
            ['ktp_match_start', 'half_end', 'player_stats_summary', 'ktp_match_end']);
    });
});

describe('getServerPlayerCount', () => {
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
        jest.useRealTimers();
    });

    async function post(body: Record<string, unknown>, hostname: string): Promise<void> {
        await request(app)
            .post('/ingest')
            .set('X-Auth-Key', 'key')
            .set('X-Server-Hostname', hostname)
            .send(body);
    }

    it('counts only allies + axis, excludes spectator/unassigned and stale players', async () => {
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.setSystemTime(new Date('2026-04-24T12:00:00Z'));

        const host = 'KTP - Count Test';
        // 3 allies
        await post({ event: 'player_connect', user_id: 'a1', name: 'A1', team: 'allies' }, host);
        await post({ event: 'player_connect', user_id: 'a2', name: 'A2', team: 'allies' }, host);
        await post({ event: 'player_connect', user_id: 'a3', name: 'A3', team: 'allies' }, host);
        // 2 axis
        await post({ event: 'player_connect', user_id: 'x1', name: 'X1', team: 'axis' }, host);
        await post({ event: 'player_connect', user_id: 'x2', name: 'X2', team: 'axis' }, host);
        // 1 spectator (HLTV bot shape)
        await post({ event: 'player_connect', user_id: 'spec1', name: 'HLTV', team: 'spectator' }, host);

        expect(getServerPlayerCount(host)).toBe(5);

        // Advance past PLAYER_STALE_MS (5 min); no further events refresh them.
        jest.setSystemTime(new Date('2026-04-24T12:06:00Z'));
        expect(getServerPlayerCount(host)).toBe(0);
    });

    it('returns 0 for an unknown server', () => {
        expect(getServerPlayerCount('never-seen-this-host')).toBe(0);
    });
});

describe('snapshot — sync invariants for late-joining clients', () => {
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

    async function post(body: Record<string, unknown>, hostname: string): Promise<void> {
        await request(app)
            .post('/ingest')
            .set('X-Auth-Key', 'key')
            .set('X-Server-Hostname', hostname)
            .send(body);
    }

    it('team_score survives half_start so half-2 carryover is replayed to late joiners', async () => {
        const host = 'KTP - Score Carryover';
        await post({ event: 'team_score', allies_score: 1, axis_score: 0 }, host);
        await post({ event: 'half_start', half: 2, timeleft: 1200 }, host);

        const snapshot = getServerSnapshot(host).map(s => JSON.parse(s));
        const ts = snapshot.find(e => e.event === 'team_score');
        expect(ts).toMatchObject({ allies_score: 1, axis_score: 0 });
    });

    it('half number is replayed in the snapshot', async () => {
        const host = 'KTP - Half';
        await post({ event: 'ktp_match_start', match_id: 'KTP-h', map: 'dod_anzio', match_type: 1, half: 1 }, host);
        await post({ event: 'half_start', half: 2, timeleft: 1200 }, host);

        const snapshot = getServerSnapshot(host).map(s => JSON.parse(s));
        const hs = snapshot.find(e => e.event === 'half_start');
        expect(hs).toMatchObject({ half: 2 });
    });

    it('round_phase is replayed when a round is live', async () => {
        const host = 'KTP - Round Live';
        await post({ event: 'time_sync', timeleft: 1180 }, host);
        await post({ event: 'round_start_freeze' }, host);
        await post({ event: 'round_start', timeleft: 1175 }, host);

        const snapshot = getServerSnapshot(host).map(s => JSON.parse(s));
        const rs = snapshot.find(e => e.event === 'round_start');
        expect(rs).toBeDefined();
    });

    // Multi-minute timer drift: a late joiner replays the cached timeleft. Without
    // age-adjustment it anchors a stale value at "now" — wrong by the cache age
    // (minutes when time_sync is wedged and only half_start refreshes the cache).
    it('age-adjusts the cached timeleft so a late joiner is not anchored stale', async () => {
        const host = 'KTP - Timeleft Age';
        await post({ event: 'time_sync', timeleft: 600 }, host);
        const t0 = Date.now();
        // 90s pass before a fresh OBS source connects. The half clock counts down
        // 1:1, so the snapshot must report ~510, not the cached 600.
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(t0 + 90_000);
        try {
            const ts = getServerSnapshot(host).map(s => JSON.parse(s)).find(e => e.event === 'time_sync');
            expect(ts).toBeDefined();
            // Fractional age-adjust (no floor since the fractional-timeleft
            // change): ~510 minus the few ms between the POST and t0.
            expect(ts.timeleft).toBeGreaterThan(509.5);
            expect(ts.timeleft).toBeLessThanOrEqual(510);
        } finally {
            nowSpy.mockRestore();
        }
    });

    // The cache may hold a half_start object (the wedge case where time_sync never
    // fired). The snapshot must still emit a clean `time_sync` (not re-emit the
    // half_start, which would re-trigger boundary handling), and the boundary
    // half_start replay carries the half number only.
    it('emits the snapshot timer as time_sync even when half_start set the cache', async () => {
        const host = 'KTP - Half Timeleft';
        await post({ event: 'half_start', half: 1, timeleft: 1200 }, host);
        const snapshot = getServerSnapshot(host).map(s => JSON.parse(s));
        const hs = snapshot.find(e => e.event === 'half_start');
        expect(hs).toMatchObject({ half: 1 });
        expect(hs.timeleft).toBeUndefined();
        const ts = snapshot.find(e => e.event === 'time_sync');
        expect(ts).toBeDefined();
        // Fractional age-adjust: age ~0 in-test but no longer floored to an int.
        expect(ts.timeleft).toBeGreaterThan(1199.5);
        expect(ts.timeleft).toBeLessThanOrEqual(1200);
    });

    it('clamps the age-adjusted timeleft to 0 when the cache outlives the value', async () => {
        const host = 'KTP - Timeleft Clamp';
        await post({ event: 'time_sync', timeleft: 30 }, host);
        const t0 = Date.now();
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(t0 + 120_000); // 120s later, only 30s were left
        try {
            const ts = getServerSnapshot(host).map(s => JSON.parse(s)).find(e => e.event === 'time_sync');
            expect(ts.timeleft).toBe(0);
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('caches victim health from damage events and includes it in roster_player replay', async () => {
        const host = 'KTP - Health Cache';
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:1', name: 'Hurt', team: 'allies' }, host);
        await post({
            event: 'player_spawn',
            user_id: 'STEAM_0:0:1', name: 'Hurt', team: 'allies',
            class_id: 0, weapon_primary: 'garand', weapon_secondary: 'colt',
        }, host);
        await post({
            event: 'damage',
            attacker_id: 'STEAM_0:0:9', victim_id: 'STEAM_0:0:1',
            damage: 60, weapon: 'k98', hitplace: 0, victim_health: 40,
        }, host);

        const snapshot = getServerSnapshot(host).map(s => JSON.parse(s));
        const roster = snapshot.find(e => e.event === 'roster_player' && e.user_id === 'STEAM_0:0:1');
        expect(roster).toMatchObject({ health: 40, alive: true });
    });

    it('roster_player snapshot reflects dead state with health=0 after a kill', async () => {
        const host = 'KTP - Dead Cache';
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:2', name: 'Gone', team: 'axis' }, host);
        await post({
            event: 'player_spawn',
            user_id: 'STEAM_0:0:2', name: 'Gone', team: 'axis',
            class_id: 0, weapon_primary: 'k98', weapon_secondary: 'luger',
        }, host);
        await post({
            event: 'kill',
            killer_id: 'STEAM_0:0:1', victim_id: 'STEAM_0:0:2',
            weapon: 'garand', kill_type: 'normal',
        }, host);

        const snapshot = getServerSnapshot(host).map(s => JSON.parse(s));
        const roster = snapshot.find(e => e.event === 'roster_player' && e.user_id === 'STEAM_0:0:2');
        expect(roster).toMatchObject({ health: 0, alive: false });
    });

    it('roster_player event from the plugin updates cached health and alive', async () => {
        const host = 'KTP - Roster';
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:3', name: 'Bandaged', team: 'allies' }, host);
        await post({
            event: 'roster_player',
            user_id: 'STEAM_0:0:3', name: 'Bandaged', team: 'allies',
            alive: true, class_id: 2, weapon_primary: 'thompson', weapon_secondary: 'colt',
            health: 75,
        }, host);

        const snapshot = getServerSnapshot(host).map(s => JSON.parse(s));
        const roster = snapshot.find(e => e.event === 'roster_player' && e.user_id === 'STEAM_0:0:3');
        expect(roster).toMatchObject({ health: 75, alive: true, class_id: 2 });
    });

    it('ktp_match_start clears the player cache', async () => {
        const host = 'KTP - Match Reset';
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:4', name: 'Old', team: 'allies' }, host);
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:5', name: 'Stale', team: 'axis' }, host);
        expect(getServerPlayerCount(host)).toBe(2);

        await post({
            event: 'ktp_match_start',
            match_id: 'KTP-fresh', map: 'dod_anzio', match_type: 1, half: 1,
        }, host);

        expect(getServerPlayerCount(host)).toBe(0);
        const snapshot = getServerSnapshot(host).map(s => JSON.parse(s));
        expect(snapshot.find(e => e.event === 'roster_player' || e.event === 'player_connect')).toBeUndefined();
    });

    it('snapshot reflects the latest team_score after a cap → tick → tick → cap sequence', async () => {
        // Models the production pattern after the dod_get_team_score → dodx_get_team_score
        // fix: TeamScore broadcasts arrive on every cap and every tick-scoring
        // increment. The snapshot must reflect the *latest* value so a
        // late-joining client doesn't see stale earlier-tick scores.
        const host = 'KTP - Score Sequence';
        await post({ event: 'team_score', allies_score: 1, axis_score: 0 }, host);  // cap
        await post({ event: 'team_score', allies_score: 1, axis_score: 0 }, host);  // re-broadcast tick (no change)
        await post({ event: 'team_score', allies_score: 2, axis_score: 0 }, host);  // tick bump
        await post({ event: 'team_score', allies_score: 2, axis_score: 1 }, host);  // axis cap

        const snapshot = getServerSnapshot(host).map(s => JSON.parse(s));
        const teamScores = snapshot.filter(e => e.event === 'team_score');
        expect(teamScores).toHaveLength(1);  // snapshot caches latest only
        expect(teamScores[0]).toMatchObject({ allies_score: 2, axis_score: 1 });
    });

    it('prone state is cached and included in roster_player replay', async () => {
        const host = 'KTP - Prone Cache';
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:6', name: 'Prone', team: 'axis' }, host);
        await post({
            event: 'player_spawn',
            user_id: 'STEAM_0:0:6', name: 'Prone', team: 'axis',
            class_id: 6, weapon_primary: 'mg42', weapon_secondary: 'luger',
        }, host);
        await post({
            event: 'prone_change',
            user_id: 'STEAM_0:0:6', state: 'deployed', timestamp: 1700000000000,
        }, host);

        const snapshot = getServerSnapshot(host).map(s => JSON.parse(s));
        const roster = snapshot.find(e => e.event === 'roster_player' && e.user_id === 'STEAM_0:0:6');
        expect(roster).toMatchObject({ prone_state: 'deployed', prone_since: 1700000000000 });
    });
});

describe('POST /ingest — HLTV sync defers socket emit but records immediately', () => {
    let tmpDir: string;
    let recorder: MatchRecorder;
    let io: SocketServer;
    let app: Application;
    let sync: HltvSyncService;
    let buffer: HltvDelayBuffer;
    let firedEvents: any[];

    const HOST = 'KTP - Sync Test';

    beforeEach(() => {
        tmpDir = makeTmpDir();
        recorder = new MatchRecorder(tmpDir);
        io = new SocketServer(createServer());
        sync = new HltvSyncService({
            enabled: true,
            heartbeat_seconds: 0,
            fallback_delay_seconds: 60,
            board_release_lag_seconds: 10,
            coast_grace_seconds: 120,
            rcon_timeout_ms: 5000,
            api_url: '',
            api_auth_key: '',
            api_timeout_ms: 3000,
            servers: { [HOST]: { hltv_addr: '127.0.0.1', hltv_port: 27020, rcon_password: 'pw' } },
        });
        // Stub the RCON sample so no UDP traffic happens during tests
        (sync as any).sample = async () => null;

        firedEvents = [];
        // Substitute a recording fire callback in place of the real socket emit
        buffer = new HltvDelayBuffer(sync, ({ event }) => firedEvents.push(event));

        const app2 = express();
        app2.use(express.json());
        const metrics = new MetricsCollector();
        app2.use('/ingest', createIngestRouter('key', recorder, io, metrics, buffer, sync));
        app = app2;
    });

    afterEach(() => {
        recorder.close();
        io.close();
    });

    it('records to disk immediately, holds socket emit', async () => {
        const matchId = 'KTP-sync-1';
        await request(app).post('/ingest').set('X-Auth-Key', 'key').set('X-Server-Hostname', HOST)
            .send({ event: 'ktp_match_start', match_id: matchId, map: 'dod_anzio', match_type: 1, half: 1, tick: 0 });
        await request(app).post('/ingest').set('X-Auth-Key', 'key').set('X-Server-Hostname', HOST)
            .send({ event: 'kill', match_id: matchId, killer_id: 'A', victim_id: 'B', weapon: 'garand', tick: 5 });

        // Disk got both events synchronously
        const lines = fs.readFileSync(path.join(tmpDir, matchId, 'events.jsonl'), 'utf-8')
            .trim().split('\n').filter(l => l);
        expect(lines).toHaveLength(2);

        // Socket emit hasn't fired — no clock yet, fallback delay (60s) hasn't elapsed
        expect(firedEvents).toHaveLength(0);

        // Inject a clock so the buffer can compute broadcastNow >= event ticks
        (sync as any).clocks.set(HOST, {
            server: HOST, cfg: { hltv_addr: '127.0.0.1', hltv_port: 27020, rcon_password: 'pw' },
            delaySeconds: 0, activeTime: 100, serveTime: 100, serveTimeMeasured: false, sampledAt: Date.now(),
            map: 'dod_anzio', serverName: HOST, online: true, lastError: null, calibrationOffsetMs: 0,
        });

        // Drive the buffer manually — both events have tick <= broadcastNow (100 - 0 = 100)
        (buffer as any).tick();
        expect(firedEvents.map(e => e.event)).toEqual(['ktp_match_start', 'kill']);
    });

    // Boundary-delay-collapse regression (the live "final minute" / halftime
    // bug): at a changelevel the plugin tick resets from high to low. The old
    // code instant-flushed the buffered old-half tail, snapping the overlay
    // ~delay seconds ahead of the HLTV feed. Now the tail moves to a wall-clock
    // drain and stays held for the broadcast delay — not flushed synchronously.
    it('holds the old-half tail on a tick reset instead of flushing it instantly', async () => {
        const matchId = 'KTP-sync-boundary';
        // Online clock: broadcast = activeTime - delay = 1000. delaySeconds=30 so
        // any drained tail waits 30s — long past the test window.
        (sync as any).clocks.set(HOST, {
            server: HOST, cfg: { hltv_addr: '127.0.0.1', hltv_port: 27020, rcon_password: 'pw' },
            delaySeconds: 30, activeTime: 1000, serveTime: 970, serveTimeMeasured: false, sampledAt: Date.now(),
            map: 'dod_anzio', serverName: HOST, online: true, lastError: null, calibrationOffsetMs: 0,
        });

        // Half-1 tail at high ticks — held (1100,1200 > broadcast 1000).
        await request(app).post('/ingest').set('X-Auth-Key', 'key').set('X-Server-Hostname', HOST)
            .send({ event: 'kill', match_id: matchId, killer_id: 'A', victim_id: 'B', weapon: 'garand', tick: 1100, map: 'dod_anzio' });
        await request(app).post('/ingest').set('X-Auth-Key', 'key').set('X-Server-Hostname', HOST)
            .send({ event: 'player_stats_summary', match_id: matchId, reason: 'half_end', players: [], tick: 1200, map: 'dod_anzio' });
        (buffer as any).tick();
        expect(firedEvents).toHaveLength(0); // held by the broadcast clock

        // Half-2 changelevel: first event arrives with a low tick. This used to
        // instant-flush the tail; now it moves it to the delayed drain.
        await request(app).post('/ingest').set('X-Auth-Key', 'key').set('X-Server-Hostname', HOST)
            .send({ event: 'ktp_match_start', match_id: matchId, map: 'dod_anzio', match_type: 1, half: 2, tick: 5 });

        // NOT flushed synchronously at the reset (the regression).
        expect(firedEvents).toHaveLength(0);
        // Driving the buffer: tail's releaseAt is ~30s out, and the reset event
        // is gated behind the drain — so still nothing fires in-window.
        (buffer as any).tick();
        expect(firedEvents).toHaveLength(0);
        // All three are still held (2 in the drain + the reset event in main).
        expect(buffer.queueDepth(HOST)).toBe(3);

        // Disk still recorded everything in real-time order, untouched by buffering.
        const lines = fs.readFileSync(path.join(tmpDir, matchId, 'events.jsonl'), 'utf-8')
            .trim().split('\n').filter(l => l);
        expect(lines).toHaveLength(3);
    });

    // Seam test for the halftime-board-late fix: the reset must snapshot the
    // pre-reset clock (captureResetBasis) and drainTail must project the tail off
    // it — releaseAt = sampledAt + (tick − activeTime + delay)×1000, tick-anchored
    // (immune to POST arrival time), with the board's UX late-bias added only to
    // the summary. Asserts the exact projected release instants through the real
    // ingest → onIngestEvent → drainTail path.
    it('drains the tail via the pre-reset broadcast-clock projection (board gets the lag)', async () => {
        const matchId = 'KTP-sync-projection';
        const T0 = Date.now();
        (sync as any).clocks.set(HOST, {
            server: HOST, cfg: { hltv_addr: '127.0.0.1', hltv_port: 27020, rcon_password: 'pw' },
            delaySeconds: 30, activeTime: 1000, serveTime: 970, serveTimeMeasured: false, sampledAt: T0,
            map: 'dod_anzio', serverName: HOST, online: true, lastError: null, calibrationOffsetMs: 0,
        });

        // Half-1 tail: a gameplay event and the halftime board, both high-tick.
        await request(app).post('/ingest').set('X-Auth-Key', 'key').set('X-Server-Hostname', HOST)
            .send({ event: 'kill', match_id: matchId, killer_id: 'A', victim_id: 'B', weapon: 'garand', tick: 1100, map: 'dod_anzio' });
        await request(app).post('/ingest').set('X-Auth-Key', 'key').set('X-Server-Hostname', HOST)
            .send({ event: 'player_stats_summary', match_id: matchId, reason: 'half_end', players: [], tick: 1200, map: 'dod_anzio' });

        // Half-2 changelevel (same map, tick resets) → captures the basis + drains the tail.
        await request(app).post('/ingest').set('X-Auth-Key', 'key').set('X-Server-Hostname', HOST)
            .send({ event: 'ktp_match_start', match_id: matchId, map: 'dod_anzio', match_type: 1, half: 2, tick: 5 });

        const drain: any[] = (buffer as any).draining.get(HOST);
        const killItem = drain.find(d => d.event.tick === 1100);
        const boardItem = drain.find(d => d.event.tick === 1200);
        // Projection off the pre-reset clock (sampledAt=T0, activeTime=1000, delay=30):
        expect(killItem.releaseAt).toBe(T0 + (1100 - 1000 + 30) * 1000);             // gameplay: no lag
        expect(boardItem.releaseAt).toBe(T0 + (1200 - 1000 + 30) * 1000 + 10 * 1000); // board: +10s lag
    });

    it('falls back to fire-immediately when sync is disabled for a server', async () => {
        const otherHost = 'KTP - Not Configured';
        const matchId = 'KTP-sync-2';
        await request(app).post('/ingest').set('X-Auth-Key', 'key').set('X-Server-Hostname', otherHost)
            .send({ event: 'ktp_match_start', match_id: matchId, map: 'dod_anzio', match_type: 1, half: 1, tick: 0 });
        // The buffer's onFire is recorded, but it shouldn't fire for the unconfigured
        // server — that path goes through fireToSockets directly. Verify buffer is empty.
        expect(buffer.queueDepth(otherHost)).toBe(0);
    });
});
