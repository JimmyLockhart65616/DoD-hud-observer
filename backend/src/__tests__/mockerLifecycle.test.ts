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
        mocker.on('action', (info: [string | string[], Record<string, unknown>]) => {
            const eventName = Array.isArray(info[0]) ? info[0][0] : info[0];
            const payload = info[1];
            scriptedCount++;
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
        // Disk holds: ktp_match_start + every scripted emit + ktp_match_end.
        // ingest.ts records ktp_match_start as both bookkeeping AND an event.
        const expectedTotal = scriptedCount + 2;
        expect(meta.eventCount).toBe(expectedTotal);

        const lines = fs
            .readFileSync(path.join(matchDir, 'events.jsonl'), 'utf-8')
            .trim()
            .split('\n')
            .filter(l => l);
        expect(lines).toHaveLength(expectedTotal);

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
    }, 30000);
});
