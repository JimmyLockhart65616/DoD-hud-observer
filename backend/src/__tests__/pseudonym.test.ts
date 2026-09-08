/**
 * The publication boundary for player identity — JimmyLockhart65616#19.
 *
 * Two separate things are pinned here, and they fail for different reasons:
 *
 *   1. The MECHANISM (mintPlayerId / resolvePlayerId / pseudonymize) — that a
 *      token is stable, scoped, reversible only in-process, and that the walker
 *      rewrites player ids without touching the several other `*_id` fields
 *      that are not players.
 *
 *   2. The SURFACES — that no SteamID actually reaches a socket emit, /api/hq,
 *      or a stored-match read. These are the tests that matter: the mechanism
 *      can be perfect and still be applied in the wrong place, which is exactly
 *      how the field got published in the first place.
 *
 * The surface tests deliberately assert on the SERIALIZED payload rather than
 * on a named field. A future event carrying a player id under a field name the
 * walker doesn't know would pass any field-by-field assertion while leaking.
 */

import express, { Application } from 'express';
import request from 'supertest';
import { Server as SocketServer } from 'socket.io';
import { createServer } from 'http';
import { io as ioClient } from 'socket.io-client';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import fs from 'fs';

import { createIngestRouter, makeFireToSockets, getServerSnapshot } from '../handler/ingest';
import { buildHqOverview } from '../handler/hqBoard';
import { MatchRecorder } from '../handler/matchRecorder';
import { MetricsCollector } from '../handler/metrics';
import {
    mintPlayerId,
    resolvePlayerId,
    resolvePlayerIds,
    pseudonymize,
    rekeyByToken,
} from '../handler/pseudonym';

import 'jest';

/** Any SteamID, in either the STEAM_0:x:y or the bare 0:x:y form. */
const STEAMID_RE = /STEAM_\d:\d:\d+|\b\d:\d:\d{4,}\b/;

function makeTmpDir(): string {
    const dir = path.join(os.tmpdir(), `hud-pseudo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

describe('pseudonym — token mechanics', () => {
    it('mints a stable, well-formed token per (scope, id)', () => {
        const a = mintPlayerId('STEAM_0:0:123', 'KTP - Atlanta 1');
        expect(a).toMatch(/^p_[0-9a-f]{16}$/);
        // Stable: the same player must key the same React row across polls.
        expect(mintPlayerId('STEAM_0:0:123', 'KTP - Atlanta 1')).toBe(a);
    });

    it('gives different players different tokens', () => {
        const scope = 'KTP - Dallas 2';
        expect(mintPlayerId('STEAM_0:0:1', scope))
            .not.toBe(mintPlayerId('STEAM_0:0:2', scope));
    });

    it('scopes tokens per server, so one player reads differently on two servers', () => {
        const id = 'STEAM_0:1:999';
        expect(mintPlayerId(id, 'KTP - Denver 5')).not.toBe(mintPlayerId(id, 'KTP - Denver 4'));
    });

    it('never emits anything resembling the input id', () => {
        expect(mintPlayerId('STEAM_0:0:748805', 'host')).not.toMatch(STEAMID_RE);
    });

    it('resolves a minted token back, and only in this process', () => {
        const token = mintPlayerId('STEAM_0:0:42', 'host');
        expect(resolvePlayerId(token)).toBe('STEAM_0:0:42');
        // A token from before a restart, or an invented one, is simply unknown —
        // callers must render that as "no record", never as an error.
        expect(resolvePlayerId('p_deadbeefdeadbeef')).toBeUndefined();
    });

    it('drops unresolvable ids from a batch instead of failing the batch', () => {
        const good = mintPlayerId('STEAM_0:0:7', 'host');
        expect(resolvePlayerIds([good, 'p_0000000000000000'])).toEqual(['STEAM_0:0:7']);
    });
});

describe('pseudonym — the event walker', () => {
    const scope = 'KTP - Walker';

    it('rewrites every player-id field, including nested and array forms', () => {
        const kill = {
            event: 'kill',
            killer_id: 'STEAM_0:0:1',
            victim_id: 'STEAM_0:0:2',
            assist_ids: ['STEAM_0:0:3', 'STEAM_0:0:4'],
            weapon: 'garand',
        };
        const out = pseudonymize(kill, scope);

        expect(JSON.stringify(out)).not.toMatch(STEAMID_RE);
        expect(out.killer_id).toBe(mintPlayerId('STEAM_0:0:1', scope));
        expect(out.assist_ids).toEqual([
            mintPlayerId('STEAM_0:0:3', scope),
            mintPlayerId('STEAM_0:0:4', scope),
        ]);
        // Untouched payload survives verbatim.
        expect(out.weapon).toBe('garand');
    });

    it('reaches ids nested inside players[] on a summary', () => {
        const summary = {
            event: 'player_stats_summary',
            reason: 'half_end',
            players: [
                { user_id: 'STEAM_0:0:11', name: 'Alice', kills: 3 },
                { user_id: 'STEAM_0:0:12', name: 'Bob', kills: 5 },
            ],
        };
        const out = pseudonymize(summary, scope);
        expect(JSON.stringify(out)).not.toMatch(STEAMID_RE);
        expect(out.players[0].user_id).toMatch(/^p_/);
        expect(out.players[0].name).toBe('Alice');
    });

    it('leaves the OTHER *_id fields alone', () => {
        // The reason SCALAR_ID_FIELDS is an explicit allowlist and not a
        // /_id$/ regex: rewriting any of these would corrupt the flag bar, the
        // class icons, or match routing, all while looking correct.
        const ev = {
            event: 'flag_captured',
            flag_id: 3,
            match_id: '1777342963-NY1',
            class_id: 5,
            captor_ids: ['STEAM_0:0:9'],
        };
        const out = pseudonymize(ev, scope);
        expect(out.flag_id).toBe(3);
        expect(out.match_id).toBe('1777342963-NY1');
        expect(out.class_id).toBe(5);
        expect(out.captor_ids[0]).toMatch(/^p_/);
    });

    it('does not mutate its input — the cache and recorder keep the real ids', () => {
        const ev = { event: 'kill', killer_id: 'STEAM_0:0:5', assist_ids: ['STEAM_0:0:6'] };
        pseudonymize(ev, scope);
        expect(ev.killer_id).toBe('STEAM_0:0:5');
        expect(ev.assist_ids[0]).toBe('STEAM_0:0:6');
    });

    // REGRESSION GUARD. /api/stats/matches/:matchId serves league-DB rows whose
    // identity column is `steam_id`, not `user_id`, so it kept publishing real
    // SteamIDs after every overlay surface was closed — 36 of them, with names and
    // full stats, on one production request. Identity reached the wire under a
    // different field name.
    it('rewrites steam_id on league stats rows', () => {
        const rows = [
            { match_id: '1777859644-ATL1', half: 0, player_id: 88,
              name: '[bb] reppo', steam_id: 'STEAM_0:0:104450108', kills: 67 },
            { match_id: '1777859644-ATL1', half: 1, player_id: 91,
              name: 'someone', steam_id: 'STEAM_0:1:22222', kills: 12 },
        ];
        const out = pseudonymize(rows, '1777859644-ATL1');

        expect(JSON.stringify(out)).not.toMatch(STEAMID_RE);
        expect(out[0].steam_id).toMatch(/^p_[0-9a-f]{16}$/);
        expect(out[0].steam_id).not.toBe(out[1].steam_id);
        // The box score itself must survive intact — only identity changes.
        expect(out[0].name).toBe('[bb] reppo');
        expect(out[0].kills).toBe(67);
        expect(out[0].match_id).toBe('1777859644-ATL1');
    });

    it('scopes stats rows per match, so one player is unlinkable across matches', () => {
        const row = { steam_id: 'STEAM_0:0:104450108' };
        expect(pseudonymize(row, 'match-A').steam_id)
            .not.toBe(pseudonymize(row, 'match-B').steam_id);
    });

    it('passes through events with no player id at all', () => {
        const ev = { event: 'round_start', timeleft: 1197.5 };
        expect(pseudonymize(ev, scope)).toEqual(ev);
    });
});

describe('rekeyByToken — the career round-trip back to token space', () => {
    const pairs = [
        { token: 'p_aaaaaaaaaaaaaaaa', steam: 'STEAM_0:0:1001' },
        { token: 'p_bbbbbbbbbbbbbbbb', steam: 'STEAM_0:0:2001' },
    ];

    it('re-keys by token and rewrites steam_id inside the row', () => {
        const careers = {
            'STEAM_0:0:1001': { steam_id: 'STEAM_0:0:1001', name: 'Sgt. Sourdough', kills: 40 },
            'STEAM_0:0:2001': { steam_id: 'STEAM_0:0:2001', name: 'mogers', kills: 20 },
        };
        const out = rekeyByToken(careers, pairs);

        // The trap: the id lives in the row body as well as in the key, so
        // re-keying alone still publishes it.
        expect(JSON.stringify(out)).not.toMatch(STEAMID_RE);
        expect(Object.keys(out).sort()).toEqual(['p_aaaaaaaaaaaaaaaa', 'p_bbbbbbbbbbbbbbbb']);
        expect(out['p_aaaaaaaaaaaaaaaa'].steam_id).toBe('p_aaaaaaaaaaaaaaaa');
        // Everything else about the career row is untouched.
        expect(out['p_aaaaaaaaaaaaaaaa'].name).toBe('Sgt. Sourdough');
        expect(out['p_aaaaaaaaaaaaaaaa'].kills).toBe(40);
    });

    it('omits players with no league record rather than emitting an empty row', () => {
        // "No row" and "a row of zeroes" render differently on the panel, so the
        // key must be absent, not present-and-empty.
        const out = rekeyByToken({ 'STEAM_0:0:1001': { steam_id: 'STEAM_0:0:1001', kills: 1 } }, pairs);
        expect(Object.keys(out)).toEqual(['p_aaaaaaaaaaaaaaaa']);
        expect(out['p_bbbbbbbbbbbbbbbb']).toBeUndefined();
    });

    it('leaves a row alone when it carries no steam_id field', () => {
        const out = rekeyByToken({ 'STEAM_0:0:1001': { kills: 3 } as any }, pairs);
        expect(out['p_aaaaaaaaaaaaaaaa']).toEqual({ kills: 3 });
    });
});

describe('publication surfaces — no SteamID may cross the wire', () => {
    let tmpDir: string;
    let recorder: MatchRecorder;
    let metrics: MetricsCollector;
    let io: SocketServer;
    let app: Application;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        recorder = new MatchRecorder(tmpDir);
        metrics = new MetricsCollector();
        io = new SocketServer(createServer());
        app = express();
        app.use(express.json());
        app.use('/ingest', createIngestRouter('key', recorder, io, metrics));
        app.get('/api/hq', (_req, res) => {
            res.json(buildHqOverview(recorder, metrics));
        });
        app.get('/api/matches/:matchId/events', (req, res) => {
            const events = recorder.getEvents(req.params.matchId);
            if (!events) { res.status(404).json({ error: 'not found' }); return; }
            const scope = recorder.getMetadata(req.params.matchId)?.sourceServer ?? req.params.matchId;
            res.json({ events: pseudonymize(events, scope) });
        });
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

    it('/api/hq carries no SteamID even with a full roster and live scores', async () => {
        const host = 'KTP - Surface HQ';
        await post({ event: 'ktp_match_start', match_id: 'm1', map: 'dod_anzio', half: 1 }, host);
        for (let i = 1; i <= 6; i++) {
            await post({ event: 'player_connect', user_id: `STEAM_0:0:${1000 + i}`, name: `Ally${i}`, team: 'allies' }, host);
            await post({ event: 'player_connect', user_id: `STEAM_0:1:${2000 + i}`, name: `Axis${i}`, team: 'axis' }, host);
        }
        await post({ event: 'player_score', user_id: 'STEAM_0:0:1001', kills: 9, deaths: 2, score: 12 }, host);

        const res = await request(app).get('/api/hq');
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toMatch(STEAMID_RE);

        const strip = res.body.servers.find((s: any) => s.hostname === host);
        expect(strip.playerCount).toBe(12);
        // The data is all still there — only the id changed.
        expect(strip.allies.find((p: any) => p.name === 'Ally1').kills).toBe(9);
    });

    it('socket emissions carry the token, while the recorder keeps the real id', async () => {
        const host = 'KTP - Surface Socket';
        const emitted: string[] = [];
        const fakeIo = {
            to() { return this; },
            emit(_event: string, payload: string) { emitted.push(payload); return true; },
        } as unknown as SocketServer;

        const fire = makeFireToSockets(fakeIo);
        fire(host, 'm-sock', {
            event: 'kill',
            killer_id: 'STEAM_0:0:1001',
            victim_id: 'STEAM_0:1:2001',
            assist_ids: ['STEAM_0:0:1002'],
            weapon: 'garand',
        });

        expect(emitted.length).toBeGreaterThan(0);
        for (const payload of emitted) {
            expect(payload).not.toMatch(STEAMID_RE);
            expect(payload).toMatch(/p_[0-9a-f]{16}/);
        }
        // The killer and victim must stay distinguishable after the swap —
        // collapsing them would silently corrupt the kill feed.
        const parsed = JSON.parse(emitted[0]);
        expect(parsed.killer_id).not.toBe(parsed.victim_id);
        expect(parsed.weapon).toBe('garand');
    });

    it('/api/matches/:id/events pseudonymizes on read while the file keeps real ids', async () => {
        const host = 'KTP - Surface Replay';
        await post({ event: 'ktp_match_start', match_id: 'm-replay', map: 'dod_donner', half: 1 }, host);
        // match_id rides every envelope the plugin emits — without it the
        // recorder cannot attribute the event and nothing reaches events.jsonl.
        await post({ event: 'player_connect', match_id: 'm-replay', user_id: 'STEAM_0:0:555', name: 'Ghost', team: 'allies' }, host);
        await post({ event: 'kill', match_id: 'm-replay', killer_id: 'STEAM_0:0:555', victim_id: 'STEAM_0:1:777', weapon: 'k98' }, host);
        await post({ event: 'ktp_match_end', match_id: 'm-replay' }, host);

        const res = await request(app).get('/api/matches/m-replay/events');
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toMatch(STEAMID_RE);

        // ...but events.jsonl on disk is the operator's record and is untouched.
        // That is the whole design: map on the way out, not at record time.
        const onDisk = fs.readFileSync(path.join(tmpDir, 'm-replay', 'events.jsonl'), 'utf8');
        expect(onDisk).toMatch(/STEAM_0:0:555/);
    });

    // REGRESSION GUARD. join_server replays the state cache directly, NOT through
    // makeFireToSockets, so the first cut of this change pseudonymized the live
    // stream and left the snapshot leaking. It is also the most-hit join path we
    // have — every OBS source reload and every /caster open takes it — so it
    // leaked more often than the live path it sat next to.
    it('the join_server snapshot replay is pseudonymized, not just the live stream', async () => {
        const host = 'KTP - Snapshot';
        await post({ event: 'ktp_match_start', match_id: 'm-snap', map: 'dod_anzio', half: 1 }, host);
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:4242', name: 'Late', team: 'allies' }, host);
        await post({ event: 'player_spawn', user_id: 'STEAM_0:0:4242', team: 'allies', class_id: 0 }, host);
        await post({ event: 'team_score', allies_score: 2, axis_score: 1 }, host);

        const httpServer = createServer();
        const liveIo = new SocketServer(httpServer, { cors: { origin: '*' } });
        // Mirror createSocketServer's join_server arm — the code under test.
        liveIo.on('connection', (s) => {
            s.on('join_server', (name: string) => {
                for (const raw of getServerSnapshot(name)) {
                    const parsed = pseudonymize(JSON.parse(raw), name);
                    s.emit(parsed.event, JSON.stringify(parsed));
                }
                s.emit('snapshot_done', '{}');
            });
        });

        await new Promise<void>(resolve => httpServer.listen(0, resolve));
        const port = (httpServer.address() as AddressInfo).port;
        const client = ioClient(`http://localhost:${port}`, { transports: ['websocket'] });

        const received: string[] = [];
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('snapshot replay timed out')), 8000);
            client.on('connect', () => client.emit('join_server', host));
            client.onAny((_evt: string, payload: string) => {
                if (_evt === 'snapshot_done') { clearTimeout(timer); resolve(); return; }
                received.push(payload);
            });
        });

        client.close();
        liveIo.close();
        httpServer.close();

        expect(received.length).toBeGreaterThan(0);
        const all = received.join('\n');
        expect(all).not.toMatch(STEAMID_RE);
        expect(all).toMatch(/p_[0-9a-f]{16}/);
    });

    it('the same player reads as the same token on /api/hq and on the socket', async () => {
        // /caster reads the socket and /hq reads the REST projection; if the two
        // disagreed, a token from one could never be looked up in the other.
        const host = 'KTP - Surface Parity';
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:31337', name: 'Parity', team: 'allies' }, host);

        const res = await request(app).get('/api/hq');
        const strip = res.body.servers.find((s: any) => s.hostname === host);
        expect(strip.allies[0].user_id).toBe(mintPlayerId('STEAM_0:0:31337', host));
    });
});
