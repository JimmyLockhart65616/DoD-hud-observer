/**
 * HQ / Operations Board tests
 *
 * Drives real events through POST /ingest and reads them back out through the
 * board projection, in-process — same style as ingest.test.ts.
 *
 * Two standing rules for this file:
 *
 *  1. Do NOT extend backend/src/invariants/eventInvariants.ts. The board
 *     introduces no new event types; the invariant gate is out of scope.
 *  2. Do NOT modify any existing test to make these pass. The ServerState
 *     changes behind this feature (`map`, `matchActive`) are purely additive
 *     with no reader in the socket/overlay path. If an existing assertion needs
 *     editing, the change was NOT additive and should be reverted instead.
 *
 * Note `serverStates` is module-level and persists across tests within this
 * file, so every test uses its own unique hostname.
 */
import express, { Application } from 'express';
import request from 'supertest';
import { createIngestRouter, getCachedServerView } from '../handler/ingest';
import { buildHqOverview, deriveStatus, type HqHltvSource } from '../handler/hqBoard';
import { MatchRecorder } from '../handler/matchRecorder';
import { MetricsCollector } from '../handler/metrics';
import { Server as SocketServer } from 'socket.io';
import { createServer } from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';

import 'jest';

function makeTmpDir(): string {
    const dir = path.join(os.tmpdir(), `hud-hq-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** A view with every field at its "nothing known" default, for deriveStatus rows. */
function emptyView(over: Partial<ReturnType<typeof getCachedServerView>> = {}) {
    return {
        hasCache: true, map: null, half: null, roundPhase: null,
        matchActive: false, alliesScore: null, axisScore: null,
        timeleft: null, flags: [], allies: [], axis: [],
        ...over,
    };
}

describe('deriveStatus — precedence rules', () => {
    it('reports NO_SIGNAL when offline, regardless of cached state', () => {
        expect(deriveStatus(false, emptyView())).toBe('NO_SIGNAL');
        // Even a fully live cache loses to loss of signal.
        expect(deriveStatus(false, emptyView({ matchActive: true, roundPhase: 'live' })))
            .toBe('NO_SIGNAL');
    });

    it('reports STALE when online with no state cache (the backend-restart window)', () => {
        expect(deriveStatus(true, emptyView({ hasCache: false }))).toBe('STALE');
    });

    it('reports BETWEEN when no match is running', () => {
        expect(deriveStatus(true, emptyView({ matchActive: false }))).toBe('BETWEEN');
    });

    it('reports BETWEEN — not LIVE — when half is stale but no match is running', () => {
        // ktp_match_end deliberately leaves `half` set (getServerSnapshot replays
        // half_start from it). A status rule keyed on `half` would read LIVE here
        // forever after the first match on a box. This row is the regression guard.
        expect(deriveStatus(true, emptyView({ half: 2, matchActive: false, roundPhase: null })))
            .toBe('BETWEEN');
    });

    it('reports WARMUP when a match is running but no round has begun', () => {
        expect(deriveStatus(true, emptyView({ matchActive: true, roundPhase: null })))
            .toBe('WARMUP');
    });

    it('reports LIVE once a round has begun, in any round phase', () => {
        for (const phase of ['freeze', 'live', 'end'] as const) {
            expect(deriveStatus(true, emptyView({ matchActive: true, roundPhase: phase })))
                .toBe('LIVE');
        }
    });
});

describe('GET /api/hq — projection over ingested events', () => {
    let tmpDir: string;
    let recorder: MatchRecorder;
    let metrics: MetricsCollector;
    let io: SocketServer;
    let app: Application;

    /** Configured for delay: only the hosts passed in are "delayed". */
    function fakeHltv(delays: Record<string, number | undefined>): HqHltvSource {
        return {
            isActive: (server) => server in delays,
            getStatus: () => Object.entries(delays).map(([server, delaySeconds]) => ({
                server, delaySeconds,
            })),
        };
    }

    beforeEach(() => {
        tmpDir = makeTmpDir();
        recorder = new MatchRecorder(tmpDir);
        metrics = new MetricsCollector();
        io = new SocketServer(createServer());
        app = express();
        app.use(express.json());
        app.use('/ingest', createIngestRouter('key', recorder, io, metrics));
        app.get('/api/hq', (_req, res) => {
            res.json(buildHqOverview(recorder, metrics, fakeHltv({})));
        });
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

    function strip(body: any, hostname: string) {
        return body.servers.find((s: any) => s.hostname === hostname);
    }

    it('keeps two servers fully isolated — roster, score and clock', async () => {
        const hostA = 'KTP - Iso A';
        const hostB = 'KTP - Iso B';

        await post({ event: 'ktp_match_start', match_id: 'm-iso-a', map: 'dod_anzio', half: 1 }, hostA);
        await post({ event: 'player_connect', user_id: 'a1', name: 'Trigger', team: 'allies' }, hostA);
        await post({ event: 'player_score', user_id: 'a1', kills: 14, deaths: 6, score: 20 }, hostA);
        await post({ event: 'team_score', allies_score: 3, axis_score: 1 }, hostA);
        await post({ event: 'time_sync', timeleft: 300 }, hostA);

        await post({ event: 'ktp_match_start', match_id: 'm-iso-b', map: 'dod_flash', half: 1 }, hostB);
        await post({ event: 'player_connect', user_id: 'b1', name: 'Nein', team: 'axis' }, hostB);
        await post({ event: 'player_score', user_id: 'b1', kills: 2, deaths: 9, score: 4 }, hostB);
        await post({ event: 'team_score', allies_score: 0, axis_score: 5 }, hostB);

        const res = await request(app).get('/api/hq');
        expect(res.status).toBe(200);

        const a = strip(res.body, hostA);
        const b = strip(res.body, hostB);

        expect(a.map).toBe('dod_anzio');
        expect(a.alliesScore).toBe(3);
        expect(a.axisScore).toBe(1);
        expect(a.allies.map((p: any) => p.name)).toEqual(['Trigger']);
        expect(a.axis).toEqual([]);
        expect(a.timeleft).toBeGreaterThan(295);

        expect(b.map).toBe('dod_flash');
        expect(b.alliesScore).toBe(0);
        expect(b.axisScore).toBe(5);
        expect(b.axis.map((p: any) => p.name)).toEqual(['Nein']);
        expect(b.allies).toEqual([]);
        expect(b.timeleft).toBeNull();
    });

    it('sorts servers by hostname so the board layout is stable across restarts', async () => {
        // POSTed out of alphabetical order — insertion order must not leak through.
        for (const host of ['KTP - Sort Zulu', 'KTP - Sort Alpha', 'KTP - Sort Mike']) {
            await post({ event: 'team_score', allies_score: 0, axis_score: 0 }, host);
        }

        const res = await request(app).get('/api/hq');
        const ours = res.body.servers
            .map((s: any) => s.hostname)
            .filter((h: string) => h.startsWith('KTP - Sort '));
        expect(ours).toEqual(['KTP - Sort Alpha', 'KTP - Sort Mike', 'KTP - Sort Zulu']);
    });

    it('splits the roster by team, carries K/D, and orders by kills desc', async () => {
        const host = 'KTP - Roster';
        await post({ event: 'player_connect', user_id: 'a1', name: 'Low', team: 'allies' }, host);
        await post({ event: 'player_connect', user_id: 'a2', name: 'High', team: 'allies' }, host);
        await post({ event: 'player_connect', user_id: 'x1', name: 'Axel', team: 'axis' }, host);
        await post({ event: 'player_score', user_id: 'a1', kills: 3, deaths: 8, score: 5 }, host);
        await post({ event: 'player_score', user_id: 'a2', kills: 11, deaths: 4, score: 15 }, host);
        await post({ event: 'player_score', user_id: 'x1', kills: 7, deaths: 7, score: 9 }, host);

        const res = await request(app).get('/api/hq');
        const s = strip(res.body, host);

        expect(s.allies).toEqual([
            { user_id: 'a2', name: 'High', kills: 11, deaths: 4 },
            { user_id: 'a1', name: 'Low', kills: 3, deaths: 8 },
        ]);
        expect(s.axis).toEqual([{ user_id: 'x1', name: 'Axel', kills: 7, deaths: 7 }]);
        expect(s.playerCount).toBe(3);
    });

    it('excludes spectators and unassigned players from both rosters and the count', async () => {
        const host = 'KTP - Spec';
        await post({ event: 'player_connect', user_id: 'a1', name: 'Real', team: 'allies' }, host);
        await post({ event: 'player_connect', user_id: 'hltv', name: 'HLTV Proxy', team: 'spectator' }, host);
        await post({ event: 'player_connect', user_id: 'idle', name: 'Joining', team: 'unassigned' }, host);

        const res = await request(app).get('/api/hq');
        const s = strip(res.body, host);

        expect(s.playerCount).toBe(1);
        const names = [...s.allies, ...s.axis].map((p: any) => p.name);
        expect(names).toEqual(['Real']);
    });

    it('age-adjusts timeleft and never sends a server timestamp as a timer basis', async () => {
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.setSystemTime(new Date('2026-07-29T12:00:00Z'));

        const host = 'KTP - Clock';
        await post({ event: 'time_sync', timeleft: 300 }, host);

        expect(getCachedServerView(host).timeleft).toBeCloseTo(300, 3);

        // 10s later the half clock has counted down 10s.
        jest.setSystemTime(new Date('2026-07-29T12:00:10Z'));
        expect(getCachedServerView(host).timeleft).toBeCloseTo(290, 3);

        const overview = buildHqOverview(recorder, metrics, fakeHltv({}));
        const s = overview.servers.find(x => x.hostname === host)!;
        expect(s.timeleft).toBeCloseTo(290, 3);

        // The only absolute timestamp in the payload is generatedAt, which is
        // documented as diagnostic. Nothing per-server may carry one, or clock
        // skew between the backend and the display would corrupt the countdown.
        expect(Object.keys(s)).not.toContain('timeleftAt');
        expect(Object.keys(s)).not.toContain('timeleftReleasedAt');
        expect(JSON.stringify(s)).not.toContain(String(Date.now()));
    });

    it('floors timeleft at zero rather than going negative', async () => {
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.setSystemTime(new Date('2026-07-29T12:00:00Z'));

        const host = 'KTP - Clock Floor';
        await post({ event: 'time_sync', timeleft: 5 }, host);

        jest.setSystemTime(new Date('2026-07-29T12:01:00Z'));
        expect(getCachedServerView(host).timeleft).toBe(0);
    });

    it('ages stale players out of the roster after PLAYER_STALE_MS', async () => {
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.setSystemTime(new Date('2026-07-29T12:00:00Z'));

        const host = 'KTP - Stale';
        await post({ event: 'player_connect', user_id: 'a1', name: 'Ghost', team: 'allies' }, host);
        expect(getCachedServerView(host).allies).toHaveLength(1);

        // 6 min with no further events referencing them (PLAYER_STALE_MS is 5 min).
        jest.setSystemTime(new Date('2026-07-29T12:06:00Z'));
        const view = getCachedServerView(host);
        expect(view.allies).toEqual([]);
        expect(view.axis).toEqual([]);
    });

    it('tracks flag ownership and exposes no stale cap-progress fields', async () => {
        const host = 'KTP - Flags';
        await post({
            event: 'flags_init',
            flags: [
                // Real flags_init rows carry zone state too; it goes stale
                // immediately because nothing updates it, so it must not surface.
                { flag_id: 0, flag_name: 'Allied Plaza', owner: 'allies', contested: false, progress: 0.4, allies_count: 2 },
                { flag_id: 1, flag_name: 'Town Square', owner: 'neutral', contested: true, progress: 0.9, axis_count: 3 },
            ],
        }, host);
        await post({ event: 'flag_captured', flag_id: 1, flag_name: 'Town Square', new_owner: 'axis' }, host);

        const res = await request(app).get('/api/hq');
        const s = strip(res.body, host);

        expect(s.flags).toEqual([
            { flag_id: 0, flag_name: 'Allied Plaza', owner: 'allies' },
            { flag_id: 1, flag_name: 'Town Square', owner: 'axis' },
        ]);
        // Guards the deliberate omission against a well-meaning future re-add.
        const serialized = JSON.stringify(s.flags);
        expect(serialized).not.toContain('progress');
        expect(serialized).not.toContain('contested');
        expect(serialized).not.toContain('_count');
    });

    it('zeroes per-player kills/deaths on half_start but keeps the roster', async () => {
        const host = 'KTP - Half Reset';
        await post({ event: 'player_connect', user_id: 'a1', name: 'Carry', team: 'allies' }, host);
        await post({ event: 'player_score', user_id: 'a1', kills: 12, deaths: 5, score: 18 }, host);
        await post({ event: 'half_start', half: 2, timeleft: 1200 }, host);

        const res = await request(app).get('/api/hq');
        const s = strip(res.body, host);

        expect(s.half).toBe(2);
        expect(s.allies).toEqual([{ user_id: 'a1', name: 'Carry', kills: 0, deaths: 0 }]);
    });

    it('reports BETWEEN after ktp_match_end even though half stays set', async () => {
        const host = 'KTP - Match End';
        await post({ event: 'ktp_match_start', match_id: 'm-end', map: 'dod_kalt', half: 2 }, host);
        await post({ event: 'round_start', timeleft: 900 }, host);

        let res = await request(app).get('/api/hq');
        expect(strip(res.body, host).status).toBe('LIVE');

        await post({ event: 'ktp_match_end', match_id: 'm-end' }, host);

        res = await request(app).get('/api/hq');
        const s = strip(res.body, host);
        expect(s.status).toBe('BETWEEN');
        // The map survives the match boundary — it's read off every event envelope,
        // so the board still labels an idle server.
        expect(s.map).toBe('dod_kalt');
    });

    it('reports WARMUP between ktp_match_start and the first round', async () => {
        const host = 'KTP - Warmup';
        await post({ event: 'ktp_match_start', match_id: 'm-warm', map: 'dod_donner', half: 1 }, host);

        const res = await request(app).get('/api/hq');
        const s = strip(res.body, host);
        expect(s.status).toBe('WARMUP');
        expect(s.roundPhase).toBeNull();
    });

    it('reports NO_SIGNAL for a server that has gone quiet past the online window', async () => {
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.setSystemTime(new Date('2026-07-29T12:00:00Z'));

        const host = 'KTP - Quiet';
        await post({ event: 'ktp_match_start', match_id: 'm-quiet', map: 'dod_anzio', half: 1 }, host);
        await post({ event: 'round_start', timeleft: 900 }, host);

        let overview = buildHqOverview(recorder, metrics, fakeHltv({}));
        expect(overview.servers.find(s => s.hostname === host)!.status).toBe('LIVE');

        // 90s of silence — past the 60s online threshold.
        jest.setSystemTime(new Date('2026-07-29T12:01:30Z'));
        overview = buildHqOverview(recorder, metrics, fakeHltv({}));
        const s = overview.servers.find(x => x.hostname === host)!;
        expect(s.status).toBe('NO_SIGNAL');
        expect(s.online).toBe(false);
        expect(s.lastEventAgeMs).toBeGreaterThanOrEqual(90_000);
    });

    it('marks a delayed server with its measured delay, and an unconfigured one as live', async () => {
        const delayed = 'KTP - Delayed';
        const live = 'KTP - Live Feed';
        await post({ event: 'team_score', allies_score: 1, axis_score: 0 }, delayed);
        await post({ event: 'team_score', allies_score: 1, axis_score: 0 }, live);

        const overview = buildHqOverview(recorder, metrics, fakeHltv({ [delayed]: 60 }));
        const d = overview.servers.find(s => s.hostname === delayed)!;
        const l = overview.servers.find(s => s.hostname === live)!;

        expect(d.delayActive).toBe(true);
        expect(d.delaySeconds).toBe(60);
        expect(l.delayActive).toBe(false);
        expect(l.delaySeconds).toBeNull();
    });

    it('reports delayActive with a null delay for a configured server with no sample yet', async () => {
        // hltvSync.getStatus() omits delaySeconds until the first RCON sample
        // lands, but the buffer still holds events. Claiming "live" would be a lie.
        const host = 'KTP - Unsampled';
        await post({ event: 'team_score', allies_score: 0, axis_score: 0 }, host);

        const overview = buildHqOverview(recorder, metrics, fakeHltv({ [host]: undefined }));
        const s = overview.servers.find(x => x.hostname === host)!;
        expect(s.delayActive).toBe(true);
        expect(s.delaySeconds).toBeNull();
    });

    it('falls back to the HLTV status map when no match has run since a restart', async () => {
        // Reproduces the LAN-kickoff gap: the plugin only stamps `map` on events
        // while a match is active, so a freshly restarted backend with a server
        // that hasn't started a match yet has no cache value at all. RCON status
        // (available independent of match state) fills it in.
        const host = 'KTP - Cold Cache';
        await post({ event: 'team_score', allies_score: 0, axis_score: 0 }, host);

        const hltvWithMap: HqHltvSource = {
            isActive: (server) => server === host,
            getStatus: () => [{ server: host, delaySeconds: 60, map: 'dod_kalt' }],
        };

        const overview = buildHqOverview(recorder, metrics, hltvWithMap);
        const s = overview.servers.find(x => x.hostname === host)!;
        expect(s.map).toBe('dod_kalt');
    });

    it('prefers the cache map over HLTV status once a match has actually reported one', async () => {
        const host = 'KTP - Cache Wins';
        await post({ event: 'ktp_match_start', match_id: 'm-cache-wins', map: 'dod_anzio', half: 1 }, host);

        const hltvWithMap: HqHltvSource = {
            isActive: (server) => server === host,
            // RCON is polling a different (later) map than what the cache has
            // recorded for the CURRENT delayed match — the cache must win, since
            // it's what the rest of the strip (score, roster) is consistent with.
            getStatus: () => [{ server: host, delaySeconds: 60, map: 'dod_flash' }],
        };

        const overview = buildHqOverview(recorder, metrics, hltvWithMap);
        const s = overview.servers.find(x => x.hostname === host)!;
        expect(s.map).toBe('dod_anzio');
    });

    it('attaches the active match id and type, and drops them once the match ends', async () => {
        const host = 'KTP - Match Meta';
        await post({ event: 'ktp_match_start', match_id: 'm-meta', map: 'dod_avalanche', match_type: 0, half: 1 }, host);

        let res = await request(app).get('/api/hq');
        let s = strip(res.body, host);
        expect(s.matchId).toBe('m-meta');
        expect(s.matchType).toBe(0);

        await post({ event: 'ktp_match_end', match_id: 'm-meta' }, host);

        res = await request(app).get('/api/hq');
        s = strip(res.body, host);
        expect(s.matchId).toBeNull();
        expect(s.matchType).toBeNull();
    });

    it('returns an empty server list when nothing has reported', () => {
        const overview = buildHqOverview(
            new MatchRecorder(makeTmpDir()),
            new MetricsCollector(),
            fakeHltv({}),
        );
        // serverStates is module-global and other tests have populated it, so
        // assert on shape rather than emptiness.
        expect(Array.isArray(overview.servers)).toBe(true);
        expect(typeof overview.generatedAt).toBe('string');
    });
});

describe('getCachedServerView — unknown server', () => {
    it('returns an inert view rather than throwing', () => {
        const view = getCachedServerView('never-seen-this-host');
        expect(view).toEqual({
            hasCache: false, map: null, half: null, roundPhase: null,
            matchActive: false, alliesScore: null, axisScore: null,
            timeleft: null, flags: [], allies: [], axis: [],
        });
    });
});
