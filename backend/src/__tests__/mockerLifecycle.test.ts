/**
 * Mocker lifecycle integration test.
 *
 * Drives MockerClass in-process — fake timers collapse its ~75s scripted
 * timeline into a single tick — with each 'action' emit translated into a
 * real POST /ingest through the same express + MatchRecorder wiring the
 * server uses. Then asserts the disk artifact (metadata.json, events.jsonl)
 * ends up shaped like a completed match.
 *
 * This is the closest thing to a full plugin sim we can build without fake
 * clients / a real game server. It verifies:
 *   - the mocker's event stream survives the ingest pipeline
 *   - event order is preserved on disk
 *   - ktp_match_start opens a match dir and ktp_match_end closes it
 *   - every scripted event is persisted (count match)
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
import MockerClass from '../mocker/MockerClass';

import 'jest';

function makeTmpDir(): string {
    const dir = path.join(os.tmpdir(), `mocker-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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

// Mirror mocker.ts wrapEnvelope — plugin-parity envelope injected on every emit.
function wrapEnvelope(
    matchId: string,
    matchType: number,
    half: number,
    eventName: string,
    payload: Record<string, unknown>,
): Record<string, unknown> {
    return {
        tick: 0,
        match_id: matchId,
        map: 'dod_anzio',
        match_type: matchType,
        half,
        plugin_sent_at: Date.now(),
        event: eventName,
        ...payload,
    };
}

describe('mocker lifecycle — scripted match round-trips through ingest → disk', () => {
    const AUTH_KEY = 'key';
    const MATCH_ID = 'KTP-mocker-lifecycle-1';
    const MATCH_TYPE = 1; // scrim
    const HALF = 1;

    let tmpDir: string;
    let recorder: MatchRecorder;
    let io: SocketServer;
    let app: Application;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        recorder = new MatchRecorder(tmpDir);
        io = new SocketServer(createServer());
        app = makeApp(AUTH_KEY, recorder, io);
    });

    afterEach(() => {
        recorder.close();
        io.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        jest.useRealTimers();
    });

    async function post(body: Record<string, unknown>): Promise<void> {
        await request(app).post('/ingest').set('X-Auth-Key', AUTH_KEY).send(body);
    }

    it('records the full scripted sequence with a clean start + end on disk', async () => {
        // ktp_match_start envelope mirrors what KTPMatchHandler's forward would
        // fire. POSTed synchronously before the scripted sequence begins.
        await post({
            event: 'ktp_match_start',
            match_id: MATCH_ID,
            map: 'dod_anzio',
            match_type: MATCH_TYPE,
            half: HALF,
        });

        // doNotFake: 'performance' — Node's performance API is read-only on
        // this runtime and sinon's modern timers crash trying to hijack it.
        jest.useFakeTimers({ doNotFake: ['performance'] });
        const mocker = new MockerClass();

        // Each 'action' maps to one /ingest POST. Collect the promises so we
        // can await them after collapsing the timeline — supertest requests
        // resolve on the microtask queue, not inside runAllTimers.
        const pending: Promise<void>[] = [];
        let scriptedCount = 0;
        let socketOnlyCount = 0;
        // Mirror ingest.ts: these high-frequency live events fan out to sockets
        // but are never written to events.jsonl, so they don't count toward disk.
        const SOCKET_ONLY = new Set(['player_state', 'weapon_active']);
        mocker.on('action', (info: [string | string[], Record<string, unknown>]) => {
            const eventName = Array.isArray(info[0]) ? info[0][0] : info[0];
            const payload = info[1];
            scriptedCount++;
            if (SOCKET_ONLY.has(eventName)) socketOnlyCount++;
            pending.push(post(wrapEnvelope(MATCH_ID, MATCH_TYPE, HALF, eventName, payload)));
        });

        let doneFired = false;
        mocker.on('done', () => {
            doneFired = true;
            pending.push(post({
                event: 'ktp_match_end',
                match_id: MATCH_ID,
                allies_score: 2,
                axis_score: 3,
            }));
        });

        mocker.start();
        jest.runAllTimers();
        jest.useRealTimers();
        await Promise.all(pending);

        expect(doneFired).toBe(true);
        expect(scriptedCount).toBeGreaterThan(50); // sanity: data.ts has 100+ events

        // ─── Assert disk state ───────────────────────────────────────────
        const matchDir = path.join(tmpDir, MATCH_ID);
        expect(fs.existsSync(matchDir)).toBe(true);

        const meta = JSON.parse(
            fs.readFileSync(path.join(matchDir, 'metadata.json'), 'utf-8'),
        );
        expect(meta.matchId).toBe(MATCH_ID);
        expect(meta.map).toBe('dod_anzio');
        expect(meta.matchType).toBe(MATCH_TYPE);
        expect(meta.half).toBe(HALF);
        expect(meta.endedAt).not.toBeNull();
        // Disk holds: ktp_match_start + every scripted emit + ktp_match_end,
        // MINUS socket-only events (player_state / weapon_active) which fan out to
        // sockets but are never persisted. ingest.ts records ktp_match_start as
        // both bookkeeping AND an event.
        const expectedTotal = scriptedCount + 2 - socketOnlyCount;
        expect(meta.eventCount).toBe(expectedTotal);

        const lines = fs
            .readFileSync(path.join(matchDir, 'events.jsonl'), 'utf-8')
            .trim()
            .split('\n')
            .filter(l => l);
        expect(lines).toHaveLength(expectedTotal);

        // Socket-only gating: the mocker emits player_state + weapon_active, but
        // ingest must keep them off disk (live overlay state, zero replay value).
        expect(socketOnlyCount).toBeGreaterThan(0); // sanity: the mocker does emit them
        const persistedEvents = lines.map(l => JSON.parse(l).event);
        expect(persistedEvents).not.toContain('player_state');
        expect(persistedEvents).not.toContain('weapon_active');

        // First line is the opening ktp_match_start.
        expect(JSON.parse(lines[0]).event).toBe('ktp_match_start');

        // Last line must be ktp_match_end — closes the match cleanly on disk.
        const lastEvent = JSON.parse(lines[lines.length - 1]);
        expect(lastEvent.event).toBe('ktp_match_end');
        expect(lastEvent.allies_score).toBe(2);
        expect(lastEvent.axis_score).toBe(3);

        // Spot check: flags_init should appear early in the log (pre-round
        // setup) and a kill event should round-trip with its weapon intact.
        const firstFlagsInit = lines
            .map(l => JSON.parse(l))
            .find((e: { event: string }) => e.event === 'flags_init');
        expect(firstFlagsInit).toBeDefined();

        const killWithGarand = lines
            .map(l => JSON.parse(l))
            .find((e: { event: string; weapon?: string }) =>
                e.event === 'kill' && e.weapon === 'garand');
        expect(killWithGarand).toBeDefined();

        // ── Stats-popup feature events round-trip to disk ────────────────
        const parsed = lines.map(l => JSON.parse(l));

        // player_stats_summary is persisted (NOT socket-only) — one per
        // authored reason: half_end, match_end, round_end (the H2 capout).
        // The per-single-flag-cap summary was removed.
        const summaries = parsed.filter((e: any) => e.event === 'player_stats_summary');
        expect(summaries.map((s: any) => s.reason).sort()).toEqual(
            ['half_end', 'match_end', 'round_end']);
        expect(summaries.some((s: any) => s.reason === 'flag_captured')).toBe(false);
        // Rows carry the full stat shape (incl. caps + best_streak).
        expect(summaries[0].players[0]).toMatchObject({
            user_id: expect.any(String), team: expect.any(String),
            kills: expect.any(Number), damage: expect.any(Number),
            assists: expect.any(Number), hs_kills: expect.any(Number),
            nade_kills: expect.any(Number), gun_kills: expect.any(Number),
            caps: expect.any(Number), best_streak: expect.any(Number),
        });

        // half_end marker is persisted.
        const halfEnd = parsed.find((e: any) => e.event === 'half_end');
        expect(halfEnd).toMatchObject({ half: 1, allies_score: 2, axis_score: 1 });

        // Kills carry kill_class + assist_ids; at least one authored assist.
        const kills = parsed.filter((e: any) => e.event === 'kill');
        expect(kills.every((k: any) => k.kill_class === 'gun' || k.kill_class === 'nade')).toBe(true);
        expect(kills.every((k: any) => Array.isArray(k.assist_ids))).toBe(true);
        expect(kills.some((k: any) => k.assist_ids.length > 0)).toBe(true);
        expect(kills.some((k: any) => k.kill_class === 'nade' && k.kill_type === 'normal')).toBe(true);
    }, 30000);

    it('does not emit production-impossible events', async () => {
        // Production fixture (8997 events) confirmed 0 occurrences of:
        // round_start_freeze, round_start, round_end, weapon_pickup,
        // weapon_drop, nade_throw, flag_cap_contested.
        // Mocker must not emit these dead events either.

        let tmpDir: string;
        let recorder: MatchRecorder;
        let io: SocketServer;
        let app: Application;

        tmpDir = makeTmpDir();
        recorder = new MatchRecorder(tmpDir);
        io = new SocketServer(createServer());
        app = makeApp(AUTH_KEY, recorder, io);

        try {
            const matchId = 'KTP-mocker-dead-events-1';

            // Start match
            await request(app).post('/ingest').set('X-Auth-Key', AUTH_KEY)
                .send({ event: 'ktp_match_start', match_id: matchId, map: 'dod_anzio', match_type: 1, half: 1 });

            // Collect mocker events
            jest.useFakeTimers({ doNotFake: ['performance'] });
            const mocker = new MockerClass();
            const events: string[] = [];

            mocker.on('action', (info: [string | string[], Record<string, unknown>]) => {
                const eventName = Array.isArray(info[0]) ? info[0][0] : info[0];
                events.push(eventName);
            });

            mocker.on('done', () => {
                // done
            });

            mocker.start();
            jest.runAllTimers();
            jest.useRealTimers();

            // Assert dead events were not emitted
            const seenEvents = new Set(events);
            expect(seenEvents.has('round_start_freeze')).toBe(false);
            expect(seenEvents.has('round_start')).toBe(false);
            expect(seenEvents.has('round_end')).toBe(false);
            expect(seenEvents.has('weapon_pickup')).toBe(false);
            expect(seenEvents.has('weapon_drop')).toBe(false);
            expect(seenEvents.has('nade_throw')).toBe(false);
            expect(seenEvents.has('flag_cap_contested')).toBe(false);
        } finally {
            recorder.close();
            io.close();
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('codifies metadata.half quirk: pre-start team_score auto-starts match with half=0', async () => {
        // Production behavior: if non-lifecycle events (team_score, player_score,
        // player_connect) arrive BEFORE ktp_match_start at the warmup boundary,
        // recorder auto-starts the match with default matchType=0/half=0. When
        // ktp_match_start then arrives, it's a no-op (match already active).
        // This is documented production behavior, not a bug. Codified here so a
        // future "fix" can't silently change the on-disk shape.

        let tmpDir: string;
        let recorder: MatchRecorder;
        let io: SocketServer;
        let app: Application;

        tmpDir = makeTmpDir();
        recorder = new MatchRecorder(tmpDir);
        io = new SocketServer(createServer());
        app = makeApp(AUTH_KEY, recorder, io);

        try {
            const matchId = 'KTP-mocker-pre-start-1';

            // Non-lifecycle event BEFORE ktp_match_start: team_score.
            // This should trigger auto-start with defaults (matchType=0, half=0).
            await request(app).post('/ingest').set('X-Auth-Key', AUTH_KEY)
                .send({ event: 'team_score', match_id: matchId, allies_score: 0, axis_score: 0 });

            // Now send ktp_match_start — should be a no-op for metadata.
            await request(app).post('/ingest').set('X-Auth-Key', AUTH_KEY)
                .send({ event: 'ktp_match_start', match_id: matchId, map: 'dod_anzio', match_type: 2, half: 1 });

            await request(app).post('/ingest').set('X-Auth-Key', AUTH_KEY)
                .send({ event: 'ktp_match_end', match_id: matchId });

            // Check: metadata should show auto-start defaults (matchType=0, half=0),
            // NOT the ktp_match_start values (matchType=2, half=1).
            const meta = JSON.parse(
                fs.readFileSync(path.join(tmpDir, matchId, 'metadata.json'), 'utf-8'),
            );
            expect(meta.matchType).toBe(0);  // auto-start default, not ktp_match_start's 2
            expect(meta.half).toBe(0);       // auto-start default, not ktp_match_start's 1
            expect(meta.map).toBe('unknown'); // auto-start default, not ktp_match_start's dod_anzio
        } finally {
            recorder.close();
            io.close();
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
