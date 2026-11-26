/**
 * Issue #35: the replay routes must not serve a match the broadcast hasn't
 * finished showing. /api/matches/live lists the active ids, so an unguarded
 * /api/matches/:id/events was a feed running ahead of the broadcast.
 *
 * Pinned here, for BOTH replay routes:
 *   - 409 while the recorder still holds the match as active
 *   - 409 after ktp_match_end while the HLTV delay buffer still holds any of
 *     the match's events, 200 once it has broadcast them
 *   - the guard lives inside the handler, so `/Events` and a trailing slash
 *     (which Express also routes here) are refused too
 *   - nothing built while live is cached as the finished body
 */
import express, { Application } from 'express';
import request from 'supertest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { MatchRecorder } from '../handler/matchRecorder';
import { BroadcastHold, createEventsHandler, createPlayerStateHandler } from '../handler/replayRoutes';
import 'jest';

const HOST = 'KTP - Guard 1';

describe('replay routes refuse a match the broadcast has not finished', () => {
    let dir: string;
    let recorder: MatchRecorder;
    let held: Set<string>;
    let app: Application;

    beforeEach(() => {
        dir = path.join(os.tmpdir(), `guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        fs.mkdirSync(dir, { recursive: true });
        recorder = new MatchRecorder(dir);
        held = new Set();
        const hold: BroadcastHold = { holdsMatch: id => held.has(id) };
        app = express();
        app.get('/api/matches/:matchId/events', createEventsHandler(recorder, hold));
        app.get('/api/matches/:matchId/player_state', createPlayerStateHandler(recorder, hold));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    function play(id: string) {
        recorder.startMatch(id, 'dod_anzio', 0, 1, HOST);
        recorder.recordEvent(id, { event: 'kill', match_id: id, killer_id: 'STEAM_0:0:1', victim_id: 'STEAM_0:0:2' }, HOST);
        recorder.recordPlayerState(id, { event: 'player_state', match_id: id, players: [] }, HOST);
    }

    const ROUTES = ['events', 'player_state'];

    it.each(ROUTES)('/%s answers 409 while the match is recording', async (route) => {
        play('live1');
        const res = await request(app).get(`/api/matches/live1/${route}`);
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/in progress/);
        expect(JSON.stringify(res.body)).not.toMatch(/STEAM_|kill/);
    });

    it.each(ROUTES)('/%s stays refused under the case and trailing-slash variants Express accepts', async (route) => {
        play('live2');
        const upper = route.charAt(0).toUpperCase() + route.slice(1);
        expect((await request(app).get(`/api/matches/live2/${upper}`)).status).toBe(409);
        expect((await request(app).get(`/api/matches/live2/${route}/`)).status).toBe(409);
    });

    it.each(ROUTES)('/%s waits for the delay buffer after the match ends', async (route) => {
        play('end1');
        recorder.endMatch('end1');
        held.add('end1');      // its last events are still waiting to be broadcast
        expect((await request(app).get(`/api/matches/end1/${route}`)).status).toBe(409);
        held.delete('end1');
        expect((await request(app).get(`/api/matches/end1/${route}`)).status).toBe(200);
    });

    it('caches only the finished body, never one read while live', async () => {
        play('race1');
        expect((await request(app).get('/api/matches/race1/player_state')).status).toBe(409);
        recorder.recordPlayerState('race1', { event: 'player_state', match_id: 'race1', players: [] }, HOST);
        recorder.endMatch('race1');
        const res = await request(app).get('/api/matches/race1/player_state');
        expect(res.status).toBe(200);
        expect(res.body.events).toHaveLength(2);
    });
});
