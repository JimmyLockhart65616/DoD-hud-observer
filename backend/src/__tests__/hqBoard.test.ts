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
 * ONE STANDING EXCEPTION to rule 2, taken deliberately in the match-phase work:
 * two rows below asserted the WARMUP side of `roundPhase != null ? LIVE : WARMUP`
 * — "a match is running but no round has begun". That rule was never reachable in
 * production. round_phase is set only by round_start_freeze/round_start/round_end,
 * and those come only from register_logevent handlers that never fire in KTPAMXX
 * extension mode, which productionFixture.test.ts asserts directly against the NY1
 * capture. So the rows encoded the bug: EVERY live match reported WARMUP forever.
 * They are now rewritten as the regression guard for the fix. Rule 2 otherwise
 * stands — the match_phase additions are additive everywhere else, and this
 * exception covers exactly those two rows and nothing more.
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
        phase: null, phaseMode: '',
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

    it('reports LIVE — never WARMUP — for a phase-less stream with a match running', () => {
        // REGRESSION GUARD (see the exception in the file header). roundPhase is
        // permanently null on the real fleet, so the old rule reported WARMUP for
        // every live production match. With no phase available, matchActive is
        // the only honest discriminator.
        expect(deriveStatus(true, emptyView({ matchActive: true, roundPhase: null })))
            .toBe('LIVE');
    });

    it('reports LIVE once a round has begun, in any round phase', () => {
        for (const phase of ['freeze', 'live', 'end'] as const) {
            expect(deriveStatus(true, emptyView({ matchActive: true, roundPhase: phase })))
                .toBe('LIVE');
        }
    });

    it('falls back to the recorder when the cache missed ktp_match_start', () => {
        // The mid-match restart case: the cache never saw the start event, but
        // MatchRecorder rehydrates active matches from disk and does know.
        expect(deriveStatus(true, emptyView({ matchActive: false, roundPhase: 'live' }), true))
            .toBe('LIVE');
        // Second half of the regression guard: same fix on the recorder path.
        expect(deriveStatus(true, emptyView({ matchActive: false, roundPhase: null }), true))
            .toBe('LIVE');
    });

    it('keeps a match LIVE while the delayed cache still says active', () => {
        // At match end the recorder flips false immediately (real time) while the
        // delayed cache is still mid-match. OR must keep it LIVE, or the board
        // would announce the end ~60s before the broadcast shows it.
        expect(deriveStatus(true, emptyView({ matchActive: true, roundPhase: 'live' }), false))
            .toBe('LIVE');
    });
});

describe('deriveStatus — plugin-computed phase', () => {
    const CASES: [string, string][] = [
        ['live', 'LIVE'],
        ['golive', 'GOLIVE'],
        ['halftime', 'HALFTIME'],
        ['ot_break', 'OTBREAK'],
        ['postmatch', 'FINAL'],
        ['pregame', 'WARMUP'],
        ['idle', 'BETWEEN'],
    ];

    it.each(CASES)('maps phase %s to status %s', (phase, status) => {
        // matchActive true throughout: the phase must be the thing deciding.
        expect(deriveStatus(true, emptyView({ phase, matchActive: true } as any))).toBe(status);
    });

    it('beats matchActive in BOTH directions', () => {
        // `halftime` while matchActive is true — ktp_half_end clears no match
        // identity, so matchActive IS true right through halftime. This is the
        // case that made a plugin-side phase necessary in the first place.
        expect(deriveStatus(true, emptyView({ phase: 'halftime', matchActive: true } as any)))
            .toBe('HALFTIME');
        // `idle` while a stale matchActive lingers (a dropped ktp_match_end).
        expect(deriveStatus(true, emptyView({ phase: 'idle', matchActive: true } as any)))
            .toBe('BETWEEN');
        // ...and the recorder must not override it either.
        expect(deriveStatus(true, emptyView({ phase: 'idle', matchActive: true } as any), true))
            .toBe('BETWEEN');
    });

    it('beats a stale roundPhase', () => {
        expect(deriveStatus(true, emptyView({ phase: 'halftime', roundPhase: 'live', matchActive: true } as any)))
            .toBe('HALFTIME');
    });

    it('still loses to NO_SIGNAL and STALE', () => {
        expect(deriveStatus(false, emptyView({ phase: 'live' } as any))).toBe('NO_SIGNAL');
        expect(deriveStatus(true, emptyView({ phase: 'live', hasCache: false } as any))).toBe('STALE');
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

    it('projects an ingested match_phase onto the strip, and freezes the clock off it', async () => {
        const host = 'KTP - Phase Proj';

        await post({ event: 'ktp_match_start', match_id: 'm-phase', map: 'dod_anzio', half: 1 }, host);
        await post({ event: 'time_sync', timeleft: 600 }, host);
        await post({ event: 'match_phase', phase: 'live', mode: '' }, host);

        let body = (await request(app).get('/api/hq')).body;
        expect(strip(body, host).phase).toBe('live');
        expect(strip(body, host).status).toBe('LIVE');
        // The clock only runs during live play.
        expect(strip(body, host).timerFrozen).toBe(false);

        // Halftime: matchActive is still true here (ktp_half_end clears no match
        // identity), so only the phase can produce the right answer.
        await post({ event: 'match_phase', phase: 'halftime', mode: 'h2' }, host);

        body = (await request(app).get('/api/hq')).body;
        expect(strip(body, host).phase).toBe('halftime');
        expect(strip(body, host).status).toBe('HALFTIME');
        expect(strip(body, host).timerFrozen).toBe(true);
    });

    it('leaves the clock RUNNING on a pub server — idle is not a break', async () => {
        // The break phases stop the clock; idle/pregame must not. A pub server has
        // a real map clock counting down, and a frozen clock beside live pub play
        // is the same class of lie the phase feed exists to remove.
        const host = 'KTP - Phase Pub Clock';
        await post({ event: 'time_sync', timeleft: 400 }, host);
        await post({ event: 'match_phase', phase: 'idle', mode: '' }, host);

        const body = (await request(app).get('/api/hq')).body;
        expect(strip(body, host).status).toBe('BETWEEN');
        expect(strip(body, host).timerFrozen).toBe(false);
    });

    it('holds FINAL after a match ends, even once the plugin reports idle', async () => {
        const host = 'KTP - Phase Final';

        await post({ event: 'ktp_match_start', match_id: 'm-final', map: 'dod_anzio', half: 2 }, host);
        await post({ event: 'match_phase', phase: 'live', mode: 'h2' }, host);
        await post({ event: 'ktp_match_end', match_id: 'm-final', allies_score: 4, axis_score: 3 }, host);
        // The plugin's own postmatch hold is a get_systime() deadline that a
        // changelevel may drop; the backend upgrades a bare `idle` for 90s.
        await post({ event: 'match_phase', phase: 'idle', mode: '' }, host);

        const body = (await request(app).get('/api/hq')).body;
        expect(strip(body, host).phase).toBe('postmatch');
        expect(strip(body, host).status).toBe('FINAL');
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

    it('keeps score, clock and roster populated for pub play (no KTP match)', async () => {
        // A server with people on it but no ktp_match_start — the common case on
        // a station between tournament matches. It is BETWEEN by definition, but
        // the score, clock and roster are live and must survive into the payload:
        // the board's job is "who's playing and what's the score", and blanking
        // this is what made a busy server look dead.
        const host = 'KTP - Pub Play';
        await post({ event: 'player_connect', user_id: 'p1', name: 'Polak', team: 'allies' }, host);
        await post({ event: 'player_connect', user_id: 'p2', name: 'Sapphire', team: 'axis' }, host);
        await post({ event: 'player_score', user_id: 'p1', kills: 21, deaths: 23, score: 30 }, host);
        await post({ event: 'player_score', user_id: 'p2', kills: 22, deaths: 8, score: 34 }, host);
        await post({ event: 'team_score', allies_score: 23, axis_score: 32 }, host);
        await post({ event: 'time_sync', timeleft: 400.7 }, host);

        const res = await request(app).get('/api/hq');
        const s = strip(res.body, host);

        expect(s.status).toBe('BETWEEN');
        expect(s.alliesScore).toBe(23);
        expect(s.axisScore).toBe(32);
        expect(s.timeleft).toBeGreaterThan(395);
        expect(s.playerCount).toBe(2);
        expect(s.allies.map((p: any) => p.name)).toEqual(['Polak']);
        expect(s.axis.map((p: any) => p.name)).toEqual(['Sapphire']);
    });

    it('reports LIVE after ktp_match_start on a phase-less stream (no round events ever arrive)', async () => {
        // REGRESSION GUARD, integration level. This asserted WARMUP, which is
        // what every production server reported for entire matches: the plugin
        // emits no round_* events in extension mode, so roundPhase stays null
        // forever. See the exception note in the file header.
        const host = 'KTP - Warmup';
        await post({ event: 'ktp_match_start', match_id: 'm-warm', map: 'dod_donner', half: 1 }, host);

        const res = await request(app).get('/api/hq');
        const s = strip(res.body, host);
        expect(s.status).toBe('LIVE');
        expect(s.roundPhase).toBeNull();
        expect(s.phase).toBeNull();
    });

    it('reports WARMUP only when the plugin actually says pregame', async () => {
        const host = 'KTP - Warmup Real';
        await post({ event: 'match_phase', phase: 'pregame', mode: '' }, host);

        const res = await request(app).get('/api/hq');
        const s = strip(res.body, host);
        expect(s.status).toBe('WARMUP');
        expect(s.phase).toBe('pregame');
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
            phase: null, phaseMode: '',
            matchActive: false, alliesScore: null, axisScore: null,
            timeleft: null, flags: [], allies: [], axis: [],
        });
    });
});
