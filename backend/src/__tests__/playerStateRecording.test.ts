/**
 * player_state.jsonl — the 4 Hz player_state / weapon_active stream recorded
 * beside events.jsonl so replays can show the weapon in hand, grenades, the
 * wave pills and the scoring tick.
 *
 * What is pinned here:
 *   - it is written only into an ACTIVE match owned by the posting server, and
 *     never auto-starts or reopens one
 *   - positions never reach disk (every replay route is public)
 *   - storage.record_player_state off writes nothing; on, a write failure never
 *     fails the POST
 *   - the route 404s without a file, refuses unsafe ids, and gzips
 *   - every append is timed for /metrics
 *   - an auto-started match takes its type from the envelope, keeping half 0
 */
import express, { Application } from 'express';
import request from 'supertest';
import { Server as SocketServer } from 'socket.io';
import { createServer } from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createIngestRouter } from '../handler/ingest';
import { MatchRecorder } from '../handler/matchRecorder';
import { MetricsCollector } from '../handler/metrics';
import { createPlayerStateHandler } from '../handler/replayRoutes';
import config from '../config';
import 'jest';

const HOST = 'KTP - Test 1';

function makeTmpDir(): string {
    const dir = path.join(os.tmpdir(), `ps-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

const STATE = {
    event: 'player_state',
    players: [
        { user_id: 'STEAM_0:0:1', weapon: 'garand', nades: 2, health: 100, prone_state: 'standing', x: 512, y: -1024 },
        { user_id: 'STEAM_0:1:2', weapon: 'mp40', nades: -1, health: 40, prone_state: 'prone', x: 0, y: 0 },
    ],
    waves: { allies: { in: 7.25, pending: 1 } },
    scoring: { in: 12.5, every: 30.5, allies: 2, axis: 0 },
};

describe('MatchRecorder.recordPlayerState', () => {
    let dir: string;
    let recorder: MatchRecorder;
    const file = (id: string) => path.join(dir, id, 'player_state.jsonl');
    const rows = (id: string) => fs.readFileSync(file(id), 'utf8').trim().split('\n').map(l => JSON.parse(l));

    beforeEach(() => { dir = makeTmpDir(); recorder = new MatchRecorder(dir); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('appends to an active match from its own server, without positions', () => {
        recorder.startMatch('m1', 'dod_anzio', 1, 1, HOST);
        expect(recorder.recordPlayerState('m1', { ...STATE, match_id: 'm1', tick: 12.5 }, HOST)).toBe(true);
        expect(recorder.recordPlayerState('m1', { event: 'weapon_active', user_id: 'STEAM_0:0:1', weapon: 'colt' }, HOST)).toBe(true);

        const [state, weapon] = rows('m1');
        expect(state.players).toEqual([
            { user_id: 'STEAM_0:0:1', weapon: 'garand', nades: 2, health: 100, prone_state: 'standing' },
            { user_id: 'STEAM_0:1:2', weapon: 'mp40', nades: -1, health: 40, prone_state: 'prone' },
        ]);
        expect(state.waves).toEqual(STATE.waves);
        expect(state.scoring).toEqual(STATE.scoring);
        expect(state.tick).toBe(12.5);
        expect(weapon).toEqual({ event: 'weapon_active', user_id: 'STEAM_0:0:1', weapon: 'colt' });
        expect(fs.readFileSync(file('m1'), 'utf8')).not.toMatch(/"x"|"y"/);
    });

    it('never auto-starts a match, never writes for another server, never after the end', () => {
        expect(recorder.recordPlayerState('ghost', STATE, HOST)).toBe(false);
        expect(fs.existsSync(path.join(dir, 'ghost'))).toBe(false);

        recorder.startMatch('m2', 'dod_anzio', 1, 1, HOST);
        expect(recorder.recordPlayerState('m2', STATE, 'KTP - Somebody Else')).toBe(false);
        recorder.endMatch('m2');
        expect(recorder.recordPlayerState('m2', STATE, HOST)).toBe(false);
        expect(fs.existsSync(file('m2'))).toBe(false);
    });

    it('does not keep an idle match alive for the reaper', () => {
        recorder.startMatch('m3', 'dod_anzio', 1, 1, HOST);
        const realNow = Date.now;
        try {
            Date.now = () => realNow() + 30 * 60 * 1000;
            recorder.recordPlayerState('m3', STATE, HOST);
            expect(recorder.reapStaleMatches(20 * 60 * 1000)).toEqual(['m3']);
        } finally {
            Date.now = realNow;
        }
    });

    it('times every append, both streams', () => {
        recorder.startMatch('m4', 'dod_anzio', 1, 1, HOST);
        recorder.recordEvent('m4', { event: 'kill', match_id: 'm4' }, HOST);
        recorder.recordPlayerState('m4', STATE, HOST);
        recorder.recordPlayerState('m4', STATE, HOST);
        const t = recorder.timings.snapshot();
        expect(t.events?.count).toBe(1);
        expect(t.player_state?.count).toBe(2);
        expect(t.player_state?.bytes).toBe(fs.statSync(file('m4')).size);
        expect(t.player_state?.p99_ms).not.toBeNull();
    });

    it('swallows a write failure instead of throwing into the ingest path', () => {
        recorder.startMatch('m5', 'dod_anzio', 1, 1, HOST);
        fs.mkdirSync(file('m5'));    // a directory where the file should be: append fails
        const err = jest.spyOn(console, 'error').mockImplementation(() => {});
        expect(recorder.recordPlayerState('m5', STATE, HOST)).toBe(false);
        expect(recorder.timings.snapshot().player_state?.errors).toBe(1);
        err.mockRestore();
    });

    it('serves the rows, skipping a torn final line, across many slices', async () => {
        recorder.startMatch('m6', 'dod_anzio', 1, 1, HOST);
        for (let i = 0; i < 1203; i++) recorder.recordPlayerState('m6', { ...STATE, tick: i }, HOST);
        fs.appendFileSync(file('m6'), '{"event":"player_st');
        const app = express();
        app.get('/api/matches/:matchId/player_state', createPlayerStateHandler(recorder));
        const res = await request(app).get('/api/matches/m6/player_state');
        expect(res.status).toBe(200);
        expect(res.body.events).toHaveLength(1203);
        expect(res.body.events.map((e: any) => e.tick)).toEqual([...Array(1203).keys()]);
        expect(await recorder.readPlayerState('nope')).toBeNull();
    });
});

describe('auto-started match type', () => {
    let dir: string;
    let recorder: MatchRecorder;
    beforeEach(() => { dir = makeTmpDir(); recorder = new MatchRecorder(dir); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('takes match_type from the envelope and keeps half 0 as the placeholder mark', () => {
        recorder.recordEvent('a1', { event: 'team_score', match_id: 'a1', map: 'dod_anzio', match_type: 2, half: 1 }, HOST);
        expect(recorder.getMetadata('a1')).toMatchObject({ matchType: 2, half: 0 });
        // ...so the lifecycle start still upgrades it
        recorder.startMatch('a1', 'dod_anzio', 2, 1, HOST);
        expect(recorder.getMetadata('a1')).toMatchObject({ matchType: 2, half: 1 });
    });

    it('falls back to 0 for a missing or unknown type', () => {
        recorder.recordEvent('a2', { event: 'kill', match_id: 'a2' }, HOST);
        recorder.recordEvent('a3', { event: 'kill', match_id: 'a3', match_type: 9 }, HOST);
        recorder.recordEvent('a4', { event: 'kill', match_id: 'a4', match_type: '2' }, HOST);
        expect(recorder.getMetadata('a2')?.matchType).toBe(0);
        expect(recorder.getMetadata('a3')?.matchType).toBe(0);
        expect(recorder.getMetadata('a4')?.matchType).toBe(0);
    });
});

describe('ingest + route', () => {
    let dir: string;
    let recorder: MatchRecorder;
    let io: SocketServer;
    let app: Application;
    const was = config.storage.record_player_state;

    beforeEach(() => {
        dir = makeTmpDir();
        recorder = new MatchRecorder(dir);
        io = new SocketServer(createServer());
        app = express();
        app.use(express.json());
        app.use('/ingest', createIngestRouter('key', recorder, io, new MetricsCollector()));
        app.get('/api/matches/:matchId/player_state', createPlayerStateHandler(recorder));
    });
    afterEach(() => {
        config.storage.record_player_state = was;
        io.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const post = (body: Record<string, unknown>, host = HOST) => request(app)
        .post('/ingest').set('X-Auth-Key', 'key').set('X-Server-Hostname', host).send(body);

    async function playMatch(id: string) {
        await post({ event: 'ktp_match_start', match_id: id, map: 'dod_anzio', half: 1 });
        expect((await post({ ...STATE, match_id: id })).status).toBe(200);
        expect((await post({ event: 'weapon_active', match_id: id, user_id: 'STEAM_0:0:1', weapon: 'colt' })).status).toBe(200);
        await post({ event: 'ktp_match_end', match_id: id });
    }

    it('writes nothing with the flag off', async () => {
        config.storage.record_player_state = false;
        await playMatch('off1');
        expect(fs.existsSync(path.join(dir, 'off1', 'player_state.jsonl'))).toBe(false);
        expect((await request(app).get('/api/matches/off1/player_state')).status).toBe(404);
        // and events.jsonl still never carries them
        expect(fs.readFileSync(path.join(dir, 'off1', 'events.jsonl'), 'utf8')).not.toMatch(/player_state|weapon_active/);
    });

    it('records with the flag on, and serves it gzipped', async () => {
        config.storage.record_player_state = true;
        await playMatch('on1');
        expect(fs.readFileSync(path.join(dir, 'on1', 'events.jsonl'), 'utf8')).not.toMatch(/player_state|weapon_active/);

        // superagent inflates a gzip response itself; the header is the proof.
        const res = await request(app).get('/api/matches/on1/player_state').set('Accept-Encoding', 'gzip');
        expect(res.status).toBe(200);
        expect(res.headers['content-encoding']).toBe('gzip');
        expect(res.body.events.map((e: any) => e.event)).toEqual(['player_state', 'weapon_active']);
        // a client that takes no gzip gets the same rows, plain, from the cache
        const plain = await request(app).get('/api/matches/on1/player_state').set('Accept-Encoding', 'identity');
        expect(plain.headers['content-encoding']).toBeUndefined();
        expect(plain.body).toEqual(res.body);
    });

    it('refuses a path-shaped match id', async () => {
        const res = await request(app).get('/api/matches/..%2F..%2Fetc/player_state');
        expect([400, 404]).toContain(res.status);
        expect((await request(app).get('/api/matches/a..b/player_state')).status).toBe(400);
    });

    it('a completed match still 409s and writes nothing', async () => {
        config.storage.record_player_state = true;
        await playMatch('done1');
        const size = fs.statSync(path.join(dir, 'done1', 'player_state.jsonl')).size;
        expect((await post({ ...STATE, match_id: 'done1' })).status).toBe(409);
        expect(fs.statSync(path.join(dir, 'done1', 'player_state.jsonl')).size).toBe(size);
    });
});
