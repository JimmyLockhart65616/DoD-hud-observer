/**
 * Ingest chaos / robustness tests
 *
 * The mocker is a clean, deterministic 6v6 happy path. Real KTP traffic is
 * messier: dropped POSTs, reconnects mid-half, renames, out-of-order arrivals,
 * partial payloads from an older plugin, and summaries that reference players
 * the cache never saw. These tests drive the per-server state machine
 * (updateServerState via the /ingest route + getServerSnapshot/Count) with
 * adversarial 6v6 sequences and assert it never crashes, never strands stale
 * state, and never fabricates players.
 *
 * Same in-process express+supertest harness as ingest.test.ts — no servers.
 */
import express, { Application } from 'express';
import request from 'supertest';
import { createIngestRouter, getServerPlayerCount, getServerSnapshot } from '../handler/ingest';
import { MatchRecorder } from '../handler/matchRecorder';
import { MetricsCollector } from '../handler/metrics';
import { Server as SocketServer } from 'socket.io';
import { createServer } from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
import 'jest';

function makeTmpDir(): string {
    const dir = path.join(os.tmpdir(), `hud-chaos-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

describe('POST /ingest — chaos / robustness (6v6)', () => {
    let tmpDir: string;
    let recorder: MatchRecorder;
    let io: SocketServer;
    let app: Application;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        recorder = new MatchRecorder(tmpDir);
        io = new SocketServer(createServer());
        app = express();
        app.use(express.json());
        const metrics = new MetricsCollector();
        app.use('/ingest', createIngestRouter('key', recorder, io, metrics));
    });

    afterEach(() => {
        recorder.close();
        io.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // Every chaos test uses a unique hostname so the module-level serverStates
    // map never bleeds between tests.
    async function post(body: Record<string, unknown>, host: string): Promise<request.Response> {
        return request(app)
            .post('/ingest')
            .set('X-Auth-Key', 'key')
            .set('X-Server-Hostname', host)
            .send(body);
    }

    function snap(host: string): any[] {
        return getServerSnapshot(host).map(s => JSON.parse(s));
    }

    const STATS = { damage: 240, assists: 2, hs_kills: 1, nade_kills: 1, gun_kills: 2, hits: 9, hs_hits: 2, caps: 3, best_streak: 4 };

    // ── Out-of-order arrivals ────────────────────────────────────────────────

    it('drops a player_score that arrives before its player_connect, then accepts it after', async () => {
        const host = 'chaos-score-before-connect';
        // Orphan score — no connect yet. Must be ignored, never fabricate a player.
        const r1 = await post({ event: 'player_score', user_id: 'STEAM_0:0:1', kills: 9, deaths: 0, score: 27 }, host);
        expect(r1.status).toBe(200);
        expect(getServerPlayerCount(host)).toBe(0);
        expect(snap(host).find(e => e.event === 'player_score')).toBeUndefined();

        // Connect, then a fresh score lands normally.
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:1', name: 'Late', team: 'allies' }, host);
        await post({ event: 'player_score', user_id: 'STEAM_0:0:1', kills: 1, deaths: 0, score: 3 }, host);
        const score = snap(host).find(e => e.event === 'player_score' && e.user_id === 'STEAM_0:0:1');
        expect(score).toMatchObject({ kills: 1, deaths: 0 });
        // The stale orphan kills:9 must NOT have leaked in.
        expect(score.kills).toBe(1);
    });

    it('drops a kill that arrives before the victim is known (no crash, no ghost)', async () => {
        const host = 'chaos-kill-before-connect';
        const r = await post({ event: 'kill', killer_id: 'STEAM_0:0:9', victim_id: 'STEAM_0:0:8', weapon: 'garand', kill_type: 'normal' }, host);
        expect(r.status).toBe(200);
        expect(getServerPlayerCount(host)).toBe(0);
        expect(snap(host).find(e => e.event === 'roster_player')).toBeUndefined();
    });

    it('ignores a damage event for an unknown victim', async () => {
        const host = 'chaos-damage-unknown';
        const r = await post({ event: 'damage', attacker_id: 'STEAM_0:0:1', victim_id: 'STEAM_0:0:2', damage: 50, victim_health: 50 }, host);
        expect(r.status).toBe(200);
        expect(getServerPlayerCount(host)).toBe(0);
    });

    // ── Reconnect / rename / team-swap mid-match ─────────────────────────────

    it('wipes a reconnecting player\'s cached stats (slot semantics), keeps the roster slot', async () => {
        const host = 'chaos-reconnect';
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:5', name: 'Drop', team: 'axis' }, host);
        await post({ event: 'player_score', user_id: 'STEAM_0:0:5', kills: 7, deaths: 2, score: 21, ...STATS }, host);

        let score = snap(host).find(e => e.event === 'player_score' && e.user_id === 'STEAM_0:0:5');
        expect(score).toMatchObject({ kills: 7, caps: 3 });

        // Disconnect drops the slot entirely; reconnect starts clean.
        await post({ event: 'player_disconnect', user_id: 'STEAM_0:0:5' }, host);
        expect(getServerPlayerCount(host)).toBe(0);
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:5', name: 'Drop', team: 'axis' }, host);

        const events = snap(host);
        expect(events.find(e => e.event === 'player_connect' && e.user_id === 'STEAM_0:0:5')).toBeDefined();
        // No stale score replayed — reconnect zeroed the slot (matches plugin slot-scoping).
        score = events.find(e => e.event === 'player_score' && e.user_id === 'STEAM_0:0:5');
        expect(score).toBeUndefined();
        expect(getServerPlayerCount(host)).toBe(1);
    });

    it('propagates an in-game rename on reconnect (dproto same-id changename)', async () => {
        const host = 'chaos-rename';
        await post({ event: 'player_connect', user_id: 'fake_42', name: 'OldName', team: 'allies' }, host);
        await post({ event: 'player_connect', user_id: 'fake_42', name: 'NewName', team: 'allies' }, host);
        const connect = snap(host).find(e => e.event === 'player_connect' && e.user_id === 'fake_42');
        expect(connect.name).toBe('NewName');
        expect(getServerPlayerCount(host)).toBe(1);  // not duplicated
    });

    it('follows a mid-match team change in the snapshot', async () => {
        const host = 'chaos-teamswap';
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:3', name: 'Swapper', team: 'allies' }, host);
        await post({ event: 'player_team_change', user_id: 'STEAM_0:0:3', team: 'axis' }, host);
        const connect = snap(host).find(e => e.event === 'player_connect' && e.user_id === 'STEAM_0:0:3');
        expect(connect.team).toBe('axis');
    });

    // ── Malformed / partial summary payloads ─────────────────────────────────

    it('survives a player_stats_summary with no players array', async () => {
        const host = 'chaos-summary-empty';
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:1', name: 'P', team: 'allies' }, host);
        const r1 = await post({ event: 'player_stats_summary', reason: 'round_end' }, host);   // players absent
        const r2 = await post({ event: 'player_stats_summary', reason: 'round_end', players: null }, host);
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
        expect(getServerPlayerCount(host)).toBe(1);
    });

    it('skips summary rows for players the cache never saw (no fabrication)', async () => {
        const host = 'chaos-summary-unknown-row';
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:1', name: 'Known', team: 'allies' }, host);
        await post({
            event: 'player_stats_summary', reason: 'half_end',
            players: [
                { user_id: 'STEAM_0:0:1', name: 'Known', team: 'allies', kills: 2, deaths: 1, obj_score: 1, ...STATS },
                { user_id: 'STEAM_0:0:GHOST', name: 'Ghost', team: 'axis', kills: 99, deaths: 0, obj_score: 9, ...STATS },
            ],
        }, host);

        // Known player merged; ghost never materialized as a player.
        expect(getServerPlayerCount(host)).toBe(1);
        const score = snap(host).find(e => e.event === 'player_score' && e.user_id === 'STEAM_0:0:1');
        expect(score).toMatchObject({ kills: 2, caps: 3 });
        expect(snap(host).find(e => e.user_id === 'STEAM_0:0:GHOST')).toBeUndefined();
    });

    it('defaults missing stat fields to 0 in a partial (old-plugin) summary row', async () => {
        const host = 'chaos-summary-partial-row';
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:2', name: 'Partial', team: 'axis' }, host);
        await post({
            event: 'player_stats_summary', reason: 'half_end',
            players: [{ user_id: 'STEAM_0:0:2', name: 'Partial', team: 'axis', kills: 3, deaths: 1, obj_score: 0 }],
        }, host);
        const score = snap(host).find(e => e.event === 'player_score' && e.user_id === 'STEAM_0:0:2');
        expect(score).toMatchObject({ kills: 3, caps: 0, best_streak: 0, damage: 0, assists: 0 });
    });

    it('is idempotent on a duplicate summary (absolute values, not increments)', async () => {
        const host = 'chaos-summary-dup';
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:1', name: 'Dup', team: 'allies' }, host);
        const summary = {
            event: 'player_stats_summary', reason: 'round_end',
            players: [{ user_id: 'STEAM_0:0:1', name: 'Dup', team: 'allies', kills: 4, deaths: 2, obj_score: 3, ...STATS }],
        };
        await post(summary, host);
        await post(summary, host);   // exact duplicate
        const score = snap(host).find(e => e.event === 'player_score' && e.user_id === 'STEAM_0:0:1');
        // Merge sets absolute values — a replayed summary must not double anything.
        expect(score).toMatchObject({ kills: 4, deaths: 2, caps: 3, damage: 240 });
    });

    // ── Dropped / out-of-order lifecycle events ──────────────────────────────

    it('evicts a stale halftime board when ktp_match_start is dropped but half_start lands', async () => {
        // Regression guard for the half-2 path where the ktp_match_start POST is
        // lost on the changelevel but half_start(half:2) survives.
        const host = 'chaos-dropped-matchstart';
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:1', name: 'Half', team: 'allies' }, host);
        await post({
            event: 'player_stats_summary', reason: 'half_end',
            players: [{ user_id: 'STEAM_0:0:1', name: 'Half', team: 'allies', kills: 5, deaths: 3, obj_score: 0, ...STATS }],
        }, host);
        expect(snap(host).find(e => e.event === 'player_stats_summary')).toBeDefined();

        await post({ event: 'half_start', half: 2, timeleft: 1200 }, host);   // no preceding ktp_match_start
        expect(snap(host).find(e => e.event === 'player_stats_summary')).toBeUndefined();
    });

    it('zeroes stats across rapid half_start → OT boundaries and tracks the latest half', async () => {
        const host = 'chaos-rapid-halves';
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:1', name: 'Marathon', team: 'allies' }, host);
        await post({ event: 'player_score', user_id: 'STEAM_0:0:1', kills: 6, deaths: 1, score: 18, ...STATS }, host);
        await post({ event: 'half_start', half: 2, timeleft: 1200 }, host);
        await post({ event: 'player_score', user_id: 'STEAM_0:0:1', kills: 2, deaths: 0, score: 6 }, host);
        await post({ event: 'half_start', half: 101, timeleft: 300 }, host);   // OT

        const events = snap(host);
        const hs = events.find(e => e.event === 'half_start');
        expect(hs).toMatchObject({ half: 101 });
        const score = events.find(e => e.event === 'player_score' && e.user_id === 'STEAM_0:0:1');
        // Last half_start (OT) zeroed everything.
        expect(score).toMatchObject({ kills: 0, deaths: 0, caps: 0, best_streak: 0, damage: 0 });
    });

    it('handles an interleaved two-server feed without cross-contamination', async () => {
        // Two game servers POST to the same backend concurrently; their caches
        // are keyed by hostname and must never bleed.
        const hostA = 'chaos-multi-A';
        const hostB = 'chaos-multi-B';
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:1', name: 'A1', team: 'allies' }, hostA);
        await post({ event: 'player_connect', user_id: 'STEAM_0:0:1', name: 'B1', team: 'axis' }, hostB);
        await post({ event: 'player_score', user_id: 'STEAM_0:0:1', kills: 5, deaths: 0, score: 15 }, hostA);
        await post({ event: 'player_score', user_id: 'STEAM_0:0:1', kills: 1, deaths: 4, score: 3 }, hostB);

        const a = snap(hostA).find(e => e.event === 'player_score' && e.user_id === 'STEAM_0:0:1');
        const b = snap(hostB).find(e => e.event === 'player_score' && e.user_id === 'STEAM_0:0:1');
        expect(a).toMatchObject({ kills: 5, deaths: 0 });
        expect(b).toMatchObject({ kills: 1, deaths: 4 });
        // Same user_id, different teams/servers — the connect rows must differ.
        expect(snap(hostA).find(e => e.event === 'player_connect').team).toBe('allies');
        expect(snap(hostB).find(e => e.event === 'player_connect').team).toBe('axis');
    });

    it('never throws on a burst of malformed / unknown-shape events', async () => {
        const host = 'chaos-garbage';
        const garbage: Record<string, unknown>[] = [
            { event: 'player_score' },                                  // no user_id
            { event: 'kill' },                                          // no killer/victim
            { event: 'prone_change', user_id: 'nobody', state: 'prone' },
            { event: 'flag_captured', flag_id: 0, new_owner: 'allies' },// no flags_init yet
            { event: 'team_score' },                                    // no scores
            { event: 'player_team_change', user_id: 'nobody', team: 'axis' },
            { event: 'totally_unknown_event', foo: 'bar' },
            { event: 'player_stats_summary' },                          // no reason, no players
        ];
        for (const g of garbage) {
            const r = await post(g, host);
            expect(r.status).toBe(200);
        }
        // Cache stayed empty and sane.
        expect(getServerPlayerCount(host)).toBe(0);
        expect(() => snap(host)).not.toThrow();
    });
});
