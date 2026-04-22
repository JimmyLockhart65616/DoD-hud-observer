/**
 * Integration tests for the /api/matches/* REST surface.
 *
 * Closes the chain: ingest POST → MatchRecorder disk write → REST read-back.
 * Runs in-process — spins up both the ingest router and the match-list/events
 * routes against the same MatchRecorder instance, then walks a full match
 * lifecycle and reads it back through the public API.
 *
 * (The E2E Playwright suite runs the mocker in --socket mode and therefore
 * bypasses the recorder entirely — asserting this in Jest is what gives us
 * the end-to-end guarantee the plan called for.)
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

import 'jest';

function makeTmpDir(): string {
    const dir = path.join(os.tmpdir(), `api-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// Wires up both /ingest and the /api/matches/* routes that app.ts exposes
// against a shared MatchRecorder, so we can POST events in and GET them back.
function makeApp(authKey: string, recorder: MatchRecorder, io: SocketServer): Application {
    const app = express();
    app.use(express.json());
    const metrics = new MetricsCollector();
    app.use('/ingest', createIngestRouter(authKey, recorder, io, metrics));

    app.get('/api/matches/live', (_req, res) => {
        res.json({
            active: recorder.getActiveMatchIds(),
            matches: recorder.getAllMetadata(),
        });
    });
    app.get('/api/matches/stored', (_req, res) => {
        res.json({ matches: recorder.listStoredMatches() });
    });
    app.get('/api/matches/:matchId/events', (req, res) => {
        const events = recorder.getEvents(req.params.matchId);
        if (!events) {
            res.status(404).json({ error: 'match not found or no events recorded' });
            return;
        }
        res.json({ events });
    });

    return app;
}

describe('GET /api/matches/* — REST read-back after ingest', () => {
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

    async function post(body: Record<string, unknown>): Promise<void> {
        await request(app).post('/ingest').set('X-Auth-Key', 'key').send(body);
    }

    it('lists the match under /api/matches/live while it is active', async () => {
        const matchId = 'KTP-live-1';
        await post({ event: 'ktp_match_start', match_id: matchId, map: 'dod_anzio', match_type: 1, half: 1 });
        await post({ event: 'kill', match_id: matchId, killer_id: 'STEAM_0:0:1', victim_id: 'STEAM_0:0:2', weapon: 'garand' });

        const res = await request(app).get('/api/matches/live');
        expect(res.status).toBe(200);
        expect(res.body.active).toContain(matchId);
        const meta = res.body.matches.find((m: { matchId: string }) => m.matchId === matchId);
        expect(meta).toMatchObject({
            matchId,
            map: 'dod_anzio',
            matchType: 1,
            half: 1,
            endedAt: null,
            eventCount: 2,
        });
    });

    it('moves the match off /live and into /stored after ktp_match_end', async () => {
        const matchId = 'KTP-stored-1';
        await post({ event: 'ktp_match_start', match_id: matchId, map: 'dod_flash', match_type: 2, half: 1 });
        await post({ event: 'kill', match_id: matchId, killer_id: 'STEAM_0:0:3', victim_id: 'STEAM_0:0:4', weapon: 'mp40' });
        await post({ event: 'ktp_match_end', match_id: matchId, allies_score: 2, axis_score: 3 });

        const live = await request(app).get('/api/matches/live');
        expect(live.body.active).not.toContain(matchId);

        const stored = await request(app).get('/api/matches/stored');
        const meta = stored.body.matches.find((m: { matchId: string }) => m.matchId === matchId);
        expect(meta).toBeDefined();
        expect(meta.matchType).toBe(2);  // scrim, persisted correctly
        expect(meta.map).toBe('dod_flash');
        expect(meta.endedAt).not.toBeNull();
        expect(meta.eventCount).toBe(3);
    });

    it('serves the full event log via /api/matches/:matchId/events', async () => {
        const matchId = 'KTP-events-1';
        const emitted = [
            { event: 'ktp_match_start', match_id: matchId, map: 'dod_anzio', match_type: 0, half: 1 },
            { event: 'half_start',      match_id: matchId, half: 1, timeleft: 1200 },
            { event: 'player_spawn',    match_id: matchId, user_id: 'STEAM_0:0:5', team: 'allies', class_id: 0, weapon_primary: 'garand' },
            { event: 'kill',            match_id: matchId, killer_id: 'STEAM_0:0:5', victim_id: 'STEAM_0:0:6', weapon: 'garand' },
            { event: 'flag_captured',   match_id: matchId, flag_id: 0, new_owner: 'allies' },
            { event: 'ktp_match_end',   match_id: matchId, allies_score: 1, axis_score: 0 },
        ];
        for (const e of emitted) await post(e);

        const res = await request(app).get(`/api/matches/${matchId}/events`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.events)).toBe(true);
        expect(res.body.events).toHaveLength(emitted.length);
        expect(res.body.events.map((e: { event: string }) => e.event)).toEqual(
            emitted.map(e => e.event),
        );
        // Spot-check a mid-log event to ensure full payload (not just event name) round-trips.
        const killRead = res.body.events.find((e: { event: string }) => e.event === 'kill');
        expect(killRead).toMatchObject({
            killer_id: 'STEAM_0:0:5',
            victim_id: 'STEAM_0:0:6',
            weapon: 'garand',
        });
    });

    it('returns 404 for an unknown matchId', async () => {
        const res = await request(app).get('/api/matches/KTP-does-not-exist/events');
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
    });
});
