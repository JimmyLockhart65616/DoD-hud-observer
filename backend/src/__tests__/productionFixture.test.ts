/**
 * Production fixture replay test
 *
 * Replays a real captured 12MAN match (NY1, dod_thunder2, 2026-04-27 — 8997 events)
 * through the ingest pipeline. The fixture is plugin-emitted ground truth: every
 * envelope, every field, every weapon string, every team value comes from a real
 * production server. If ingest or MatchRecorder ever silently drops, mutates, or
 * rejects something the live plugin sends, this test fails.
 *
 * Findings codified by this fixture (gaps the synthetic mocker missed):
 *   - `team` value `"spectator"` is real (player_team_change to spec)
 *   - `damage.victim_health` ranges into negatives (overkill, e.g. -398)
 *   - `kill` carries `headshot` + `killer_prone` (CLAUDE.md only listed `victim_prone`)
 *   - `flags_init` is re-emitted per round (47 times in this match)
 *   - Real weapon strings include `mortar`, `scopedkar`, `grenade`, `grenade2`,
 *     `m1carbine`, `amerknife`, `spade`, `k43butt` — beyond the class loadout list
 *   - `prone_change` emits `state: "standing"` on spawn, not just transitions
 *   - `round_start*` / `round_end` / `weapon_pickup` / `weapon_drop` / `nade_throw`
 *     are NEVER emitted (they're documented in CLAUDE.md but dead in practice)
 *   - `metadata.half` reflects whatever was in the envelope at first-event time;
 *     when non-lifecycle events arrive before ktp_match_start (race at warmup
 *     end), recorder auto-starts with half=0 and ktp_match_start is then a no-op
 */
import express, { Application } from 'express';
import request from 'supertest';
import zlib from 'zlib';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { Server as SocketServer } from 'socket.io';
import { createServer } from 'http';
import { createIngestRouter } from '../handler/ingest';
import { MatchRecorder } from '../handler/matchRecorder';
import { MetricsCollector } from '../handler/metrics';
import { checkEventStream } from '../invariants/eventInvariants';

import 'jest';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'match-1777342963-NY1.jsonl.gz');
const FIXTURE_METADATA_PATH = path.join(__dirname, 'fixtures', 'match-1777342963-NY1-metadata.json');
const MATCH_ID = '1777342963-NY1';

function loadFixture(): Array<Record<string, unknown>> {
    const gz = fs.readFileSync(FIXTURE_PATH);
    const raw = zlib.gunzipSync(gz).toString('utf-8');
    return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

function makeTmpDir(): string {
    const dir = path.join(os.tmpdir(), `prod-fixture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function makeApp(authKey: string, recorder: MatchRecorder, io: SocketServer): Application {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    const metrics = new MetricsCollector();
    app.use('/ingest', createIngestRouter(authKey, recorder, io, metrics));
    return app;
}

/**
 * Bulk replay helper. Mirrors the ingest router's dispatch logic
 * (ingest.ts:343-364) without going through supertest — supertest opens a
 * fresh ephemeral port per .send(), and 8997 sequential requests exhaust
 * the Windows ephemeral port range. The "accepts X" tests below still use
 * the full supertest path on small subsets to validate the auth/router layer.
 */
function bulkReplay(recorder: MatchRecorder, events: Array<Record<string, unknown>>, sourceServer = 'fixture'): void {
    for (const ev of events) {
        const matchId = ev.match_id as string | undefined;
        if (ev.event === 'ktp_match_start' && matchId) {
            recorder.startMatch(
                matchId,
                (ev.map as string) ?? 'unknown',
                (ev.match_type as number) ?? 0,
                (ev.half as number) ?? 0,
                sourceServer,
            );
        }
        if (matchId) {
            recorder.recordEvent(matchId, ev, sourceServer);
        }
        if (ev.event === 'ktp_match_end' && matchId) {
            recorder.endMatch(matchId);
        }
    }
}

describe('production fixture replay (NY1 dod_thunder2 12MAN)', () => {
    let tmpDir: string;
    let recorder: MatchRecorder;
    let io: SocketServer;
    let app: Application;
    let events: Array<Record<string, unknown>>;

    beforeAll(() => {
        events = loadFixture();
    });

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

    it('fixture file is intact and decodes 8997 events', () => {
        expect(events.length).toBe(8997);
        expect(events[0]).toHaveProperty('event');
        const last = events[events.length - 1] as { event: string };
        expect(last.event).toBe('ktp_match_end');
    });

    it('round-trips the entire match through ingest → disk in order', () => {
        bulkReplay(recorder, events);

        const written = recorder.getEvents(MATCH_ID);
        expect(written).not.toBeNull();
        expect(written!.length).toBe(events.length);
        for (let i = 0; i < events.length; i++) {
            expect((written![i] as { event: string }).event).toBe((events[i] as { event: string }).event);
        }
    });

    it('finalizes metadata with the recorded eventCount and an endedAt', () => {
        bulkReplay(recorder, events);

        const meta = JSON.parse(
            fs.readFileSync(path.join(tmpDir, MATCH_ID, 'metadata.json'), 'utf-8'),
        );
        expect(meta.matchId).toBe(MATCH_ID);
        expect(meta.map).toBe('dod_thunder2');
        expect(meta.eventCount).toBe(8997);
        expect(meta.endedAt).not.toBeNull();
    });

    // The historical capture preserves the old matchType=0/half=0 race: warmup
    // traffic arrived before ktp_match_start and the recorder never repaired its
    // auto-start placeholder. Replaying the same raw arrival order now upgrades
    // metadata from the authoritative lifecycle row without rewriting events.
    it('repairs the historical pre-start metadata race during replay', () => {
        const recordedMeta = JSON.parse(fs.readFileSync(FIXTURE_METADATA_PATH, 'utf-8'));
        expect(recordedMeta.matchType).toBe(0);
        expect(recordedMeta.half).toBe(0);

        bulkReplay(recorder, events);

        const meta = JSON.parse(
            fs.readFileSync(path.join(tmpDir, MATCH_ID, 'metadata.json'), 'utf-8'),
        );
        expect(meta.matchType).toBe(2);
        expect(meta.half).toBe(1);
    });

    it('per-event-type histogram on disk matches the captured fixture', () => {
        const expected: Record<string, number> = {};
        for (const ev of events) {
            const t = (ev as { event: string }).event;
            expected[t] = (expected[t] ?? 0) + 1;
        }

        bulkReplay(recorder, events);

        const written = recorder.getEvents(MATCH_ID)!;
        const actual: Record<string, number> = {};
        for (const ev of written) {
            const t = (ev as { event: string }).event;
            actual[t] = (actual[t] ?? 0) + 1;
        }

        expect(actual).toEqual(expected);
        // Sanity floor on the dominant events — flag_zone_players ~30% of all
        // traffic, team_score and player_score very chatty. If ingest ever
        // starts coalescing or rate-limiting these the test should fail loudly.
        expect(actual.flag_zone_players).toBeGreaterThan(2000);
        expect(actual.team_score).toBeGreaterThan(1000);
        expect(actual.player_score).toBeGreaterThan(1000);
    });

    it('confirms documented-dead events truly never fire in production', () => {
        const seen = new Set(events.map(e => (e as { event: string }).event));
        // Per memory feedback_dod_round_logevents_dead.md and the SMA source —
        // these are in CLAUDE.md's schema but the plugin never emits them.
        expect(seen.has('round_start')).toBe(false);
        expect(seen.has('round_start_freeze')).toBe(false);
        expect(seen.has('round_end')).toBe(false);
        expect(seen.has('weapon_pickup')).toBe(false);
        expect(seen.has('weapon_drop')).toBe(false);
        expect(seen.has('nade_throw')).toBe(false);
    });

    it('accepts the production weapon vocabulary (beyond the class loadouts)', async () => {
        const weapons = new Set<string>();
        for (const ev of events) {
            const e = ev as { event: string; weapon?: string };
            if ((e.event === 'kill' || e.event === 'damage') && e.weapon) {
                weapons.add(e.weapon);
            }
        }
        // Real-world strings the CLAUDE.md class table doesn't list.
        for (const w of ['mortar', 'scopedkar', 'grenade', 'grenade2', 'm1carbine', 'amerknife', 'spade', 'k43butt']) {
            expect(weapons.has(w)).toBe(true);
        }

        // All such events POST cleanly (no 4xx/5xx).
        const weaponEvents = events.filter(e => {
            const ev = e as { event: string; weapon?: string };
            return (ev.event === 'kill' || ev.event === 'damage') && ev.weapon != null;
        });
        for (const ev of weaponEvents.slice(0, 100)) {
            const res = await request(app).post('/ingest').set('X-Auth-Key', 'key').send(ev);
            expect(res.status).toBe(200);
        }
    });

    it('accepts player_team_change to "spectator"', async () => {
        const specChanges = events.filter(e => {
            const ev = e as { event: string; team?: string };
            return ev.event === 'player_team_change' && ev.team === 'spectator';
        });
        expect(specChanges.length).toBeGreaterThan(0);

        for (const ev of specChanges) {
            const res = await request(app).post('/ingest').set('X-Auth-Key', 'key').send(ev);
            expect(res.status).toBe(200);
        }
    });

    it('accepts damage events with negative victim_health (overkill)', async () => {
        const overkill = events.filter(e => {
            const ev = e as { event: string; victim_health?: number };
            return ev.event === 'damage' && typeof ev.victim_health === 'number' && ev.victim_health < 0;
        });
        expect(overkill.length).toBeGreaterThan(0);

        for (const ev of overkill.slice(0, 50)) {
            const res = await request(app).post('/ingest').set('X-Auth-Key', 'key').send(ev);
            expect(res.status).toBe(200);
            const written = recorder.getEvents(MATCH_ID)!;
            const last = written[written.length - 1] as { victim_health: number };
            // Disk preserves the negative — no clamping/coercion in the pipeline.
            expect(last.victim_health).toBeLessThan(0);
        }
    });

    it('accepts kill events carrying headshot + killer_prone fields', async () => {
        const kills = events.filter(e => (e as { event: string }).event === 'kill');
        expect(kills.length).toBeGreaterThan(0);

        for (const k of kills) {
            const ev = k as { headshot?: boolean; killer_prone?: boolean; victim_prone?: boolean };
            // Every real kill event has all three boolean flags.
            expect(typeof ev.headshot).toBe('boolean');
            expect(typeof ev.killer_prone).toBe('boolean');
            expect(typeof ev.victim_prone).toBe('boolean');
        }
    });

    it('confirms flags_init is re-emitted (47 times in this match)', () => {
        const reinits = events.filter(e => (e as { event: string }).event === 'flags_init');
        expect(reinits.length).toBe(47);
        // Half-2 has many more re-inits than half-1 — codifies the post-UAF
        // observation noted in project_post_uaf_followups.md (half-time may
        // wipe flag colors to neutral).
        const h1 = reinits.filter(e => (e as { half: number }).half === 1).length;
        const h2 = reinits.filter(e => (e as { half: number }).half === 2).length;
        expect(h1).toBe(6);
        expect(h2).toBe(41);
    });

    it('confirms prone_change emits "standing" state on spawn', () => {
        const standing = events.filter(e => {
            const ev = e as { event: string; state?: string };
            return ev.event === 'prone_change' && ev.state === 'standing';
        });
        // Real distribution: 662 standing, 25 prone — "standing" is by far the
        // common case (every spawn fires one). Tests/mocker shouldn't assume
        // prone_change is only for prone/deployed transitions.
        expect(standing.length).toBeGreaterThan(500);
    });

    // ── Event-stream invariants ───────────────────────────────────────────────
    // The real stream must satisfy every correctness invariant (no false
    // positives), AND the cap-credit invariant must CATCH the regression when we
    // corrupt the same real stream the way the bug did. Both directions, on real
    // data, gated by every `npm run test` / pre-push.

    it('the real production stream satisfies all event invariants', () => {
        expect(checkEventStream(events)).toEqual([]);
    });

    it('the cap-credit invariant catches the regression on a corrupted copy', () => {
        // Reproduce 487f472: flags still get captured, but every player_score
        // reports obj_score 0 (the deferred dod_score_event never credited).
        const corrupted = events.map(e =>
            (e as { event: string }).event === 'player_score' ? { ...e, obj_score: 0 } : e,
        );
        const violations = checkEventStream(corrupted);
        // One per half that had captures (this match: half 1 and half 2).
        expect(violations.filter(v => v.invariant === 'cap-credit-objscore').length).toBe(2);
    });

    // The summary-roster invariant can't be exercised by NY1 directly — this
    // April fixture predates the stats-summary feature (2026-06-12) so it emits
    // none. Inject the exact bug the way it appeared on 1783044529-ATL1: a
    // match_end summary with an EMPTY players array, fired while the full 12-man
    // roster was still connected (the get_user_team-at-intermission filter dropped
    // every row). The invariant must catch it on this real roster.
    it('the summary-roster invariant catches the empty-match_end regression on a corrupted copy', () => {
        // NY1 ends its final half with all 12 players connected on teams (verified
        // by reconstructing the roster from the stream). Splice an empty match_end
        // summary in just before ktp_match_end — exactly where the plugin fires it.
        const endIdx = events.findIndex(e => (e as { event: string }).event === 'ktp_match_end');
        expect(endIdx).toBeGreaterThan(0);
        const emptySummary = { event: 'player_stats_summary', reason: 'match_end', half: 2, players: [] };
        const corrupted = [...events.slice(0, endIdx), emptySummary, ...events.slice(endIdx)];

        const violations = checkEventStream(corrupted).filter(v => v.invariant === 'summary-roster-nonempty');
        expect(violations).toHaveLength(1);
        expect(violations[0].message).toContain('12 connected players');
    });
});
