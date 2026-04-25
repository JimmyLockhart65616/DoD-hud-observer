/**
 * MatchRecorder unit tests
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MatchRecorder } from '../handler/matchRecorder';

function makeTmpDir(): string {
    const dir = path.join(os.tmpdir(), `recorder-test-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

describe('MatchRecorder', () => {
    let tmpDir: string;
    let recorder: MatchRecorder;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        recorder = new MatchRecorder(tmpDir);
    });

    afterEach(() => {
        recorder.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('startMatch', () => {
        it('creates match directory', () => {
            recorder.startMatch('KTP-001', 'dod_anzio', 1, 1, '10.0.0.1');
            expect(fs.existsSync(path.join(tmpDir, 'KTP-001'))).toBe(true);
        });

        it('writes metadata.json with correct fields', () => {
            recorder.startMatch('KTP-002', 'dod_flash', 1, 2, '10.0.0.2');
            const meta = JSON.parse(
                fs.readFileSync(path.join(tmpDir, 'KTP-002', 'metadata.json'), 'utf-8')
            );
            expect(meta.matchId).toBe('KTP-002');
            expect(meta.map).toBe('dod_flash');
            expect(meta.half).toBe(2);
            expect(meta.sourceServer).toBe('10.0.0.2');
            expect(meta.endedAt).toBeNull();
        });

        it('creates empty events.jsonl', () => {
            recorder.startMatch('KTP-003', 'dod_anzio', 1, 1, 'localhost');
            const jsonlPath = path.join(tmpDir, 'KTP-003', 'events.jsonl');
            expect(fs.existsSync(jsonlPath)).toBe(true);
        });

        it('does not throw on duplicate startMatch', () => {
            recorder.startMatch('KTP-004', 'dod_anzio', 1, 1, 'localhost');
            expect(() => {
                recorder.startMatch('KTP-004', 'dod_anzio', 1, 1, 'localhost');
            }).not.toThrow();
        });
    });

    describe('recordEvent', () => {
        it('appends events as JSONL lines', () => {
            recorder.startMatch('KTP-010', 'dod_anzio', 1, 1, 'localhost');
            recorder.recordEvent('KTP-010', { event: 'kill', weapon: 'garand' }, 'localhost');
            recorder.recordEvent('KTP-010', { event: 'round_end', winner: 'allies' }, 'localhost');

            const lines = fs.readFileSync(path.join(tmpDir, 'KTP-010', 'events.jsonl'), 'utf-8')
                .trim().split('\n').filter(l => l);
            expect(lines).toHaveLength(2);
            expect(JSON.parse(lines[0]).event).toBe('kill');
            expect(JSON.parse(lines[1]).event).toBe('round_end');
        });

        it('auto-starts match if no startMatch was called', () => {
            recorder.recordEvent('KTP-011', { event: 'kill' }, 'localhost');
            expect(fs.existsSync(path.join(tmpDir, 'KTP-011', 'events.jsonl'))).toBe(true);
        });

        it('increments eventCount in memory', () => {
            recorder.startMatch('KTP-012', 'dod_anzio', 1, 1, 'localhost');
            recorder.recordEvent('KTP-012', { event: 'e1' }, 'localhost');
            recorder.recordEvent('KTP-012', { event: 'e2' }, 'localhost');
            expect(recorder.getMetadata('KTP-012')!.eventCount).toBe(2);
        });
    });

    describe('endMatch', () => {
        it('writes endedAt to metadata.json', () => {
            recorder.startMatch('KTP-020', 'dod_anzio', 1, 1, 'localhost');
            recorder.recordEvent('KTP-020', { event: 'kill' }, 'localhost');
            recorder.endMatch('KTP-020');

            const meta = JSON.parse(
                fs.readFileSync(path.join(tmpDir, 'KTP-020', 'metadata.json'), 'utf-8')
            );
            expect(meta.endedAt).not.toBeNull();
            expect(typeof meta.endedAt).toBe('string');
        });

        it('writes final eventCount to metadata.json', () => {
            recorder.startMatch('KTP-021', 'dod_anzio', 1, 1, 'localhost');
            recorder.recordEvent('KTP-021', { event: 'e1' }, 'localhost');
            recorder.recordEvent('KTP-021', { event: 'e2' }, 'localhost');
            recorder.recordEvent('KTP-021', { event: 'e3' }, 'localhost');
            recorder.endMatch('KTP-021');

            const meta = JSON.parse(
                fs.readFileSync(path.join(tmpDir, 'KTP-021', 'metadata.json'), 'utf-8')
            );
            expect(meta.eventCount).toBe(3);
        });

        it('removes match from active list after end', () => {
            recorder.startMatch('KTP-022', 'dod_anzio', 1, 1, 'localhost');
            expect(recorder.getActiveMatchIds()).toContain('KTP-022');
            recorder.endMatch('KTP-022');
            expect(recorder.getActiveMatchIds()).not.toContain('KTP-022');
        });

        it('does not throw on endMatch for unknown matchId', () => {
            expect(() => recorder.endMatch('does-not-exist')).not.toThrow();
        });
    });

    describe('listStoredMatches', () => {
        it('returns matches that have metadata.json on disk', () => {
            recorder.startMatch('KTP-030', 'dod_anzio', 1, 1, 'localhost');
            recorder.startMatch('KTP-031', 'dod_flash', 1, 2, 'localhost');
            const stored = recorder.listStoredMatches();
            const ids = stored.map(m => m.matchId);
            expect(ids).toContain('KTP-030');
            expect(ids).toContain('KTP-031');
        });

        it('returns empty array when matches dir is empty', () => {
            const emptyDir = path.join(tmpDir, 'empty');
            fs.mkdirSync(emptyDir);
            const emptyRecorder = new MatchRecorder(emptyDir);
            expect(emptyRecorder.listStoredMatches()).toEqual([]);
        });
    });

    // KTPMatchHandler MATCH_TYPE enum (KTPMatchHandler.sma:84):
    //   0=COMPETITIVE, 1=SCRIM, 2=12MAN, 3=DRAFT, 4=KTP_OT, 5=DRAFT_OT.
    // OT matches carry half >= 101.
    describe('match type + half parametrization', () => {
        it.each([
            { name: 'competitive', matchType: 0, half: 1   },
            { name: 'scrim',       matchType: 1, half: 1   },
            { name: '12man',       matchType: 2, half: 1   },
            { name: 'draft',       matchType: 3, half: 1   },
            { name: 'ktpOT',       matchType: 4, half: 101 },
            { name: 'draftOT',     matchType: 5, half: 103 },
        ])('round-trips $name through metadata.json (type=$matchType, half=$half)',
            ({ matchType, half }) => {
                const matchId = `KTP-rt-${matchType}-${half}`;
                recorder.startMatch(matchId, 'dod_anzio', matchType, half, 'localhost');
                recorder.recordEvent(matchId, { event: 'kill' }, 'localhost');
                recorder.endMatch(matchId);

                const meta = JSON.parse(
                    fs.readFileSync(path.join(tmpDir, matchId, 'metadata.json'), 'utf-8')
                );
                expect(meta.matchType).toBe(matchType);
                expect(meta.half).toBe(half);
                expect(meta.endedAt).not.toBeNull();
                expect(meta.eventCount).toBe(1);
            }
        );
    });

    describe('rehydrateActiveMatches (constructor)', () => {
        it('rehydrates a match whose metadata.json has endedAt:null', () => {
            // Simulate a backend that started a match, recorded events, then died
            // without a clean endMatch — so metadata.json sits at endedAt:null.
            const old = new MatchRecorder(tmpDir);
            old.startMatch('KTP-rehy-1', 'dod_anzio', 1, 1, 'localhost');
            old.recordEvent('KTP-rehy-1', { event: 'kill' }, 'localhost');
            old.recordEvent('KTP-rehy-1', { event: 'kill' }, 'localhost');
            old.recordEvent('KTP-rehy-1', { event: 'kill' }, 'localhost');
            // Deliberately no endMatch — leaves endedAt:null on disk.

            // New recorder over the same dir — simulates backend restart.
            const fresh = new MatchRecorder(tmpDir);
            expect(fresh.getActiveMatchIds()).toContain('KTP-rehy-1');
            // eventCount recovered from events.jsonl line count, not the
            // stale `0` in metadata.json.
            expect(fresh.getMetadata('KTP-rehy-1')!.eventCount).toBe(3);
        });

        it('does not rehydrate matches that ended cleanly', () => {
            const old = new MatchRecorder(tmpDir);
            old.startMatch('KTP-rehy-2', 'dod_anzio', 1, 1, 'localhost');
            old.recordEvent('KTP-rehy-2', { event: 'kill' }, 'localhost');
            old.endMatch('KTP-rehy-2');

            const fresh = new MatchRecorder(tmpDir);
            expect(fresh.getActiveMatchIds()).not.toContain('KTP-rehy-2');
        });

        it('seeds lastEventAt from events.jsonl mtime so stale orphans get reaped', () => {
            const old = new MatchRecorder(tmpDir);
            old.startMatch('KTP-rehy-stale', 'dod_anzio', 1, 1, 'localhost');
            old.recordEvent('KTP-rehy-stale', { event: 'kill' }, 'localhost');

            // Backdate the events.jsonl mtime to 1 hour ago.
            const jsonlPath = path.join(tmpDir, 'KTP-rehy-stale', 'events.jsonl');
            const oneHourAgo = (Date.now() - 60 * 60 * 1000) / 1000;
            fs.utimesSync(jsonlPath, oneHourAgo, oneHourAgo);

            const fresh = new MatchRecorder(tmpDir);
            const reaped = fresh.reapStaleMatches(20 * 60 * 1000);
            expect(reaped).toEqual(['KTP-rehy-stale']);
        });
    });

    describe('eventCount flush during recordEvent', () => {
        it('persists eventCount to metadata.json every 100 events', () => {
            recorder.startMatch('KTP-flush', 'dod_anzio', 1, 1, 'localhost');
            const metaPath = path.join(tmpDir, 'KTP-flush', 'metadata.json');

            // After 99 events, metadata.json is still at the startMatch value (0).
            for (let i = 0; i < 99; i++) {
                recorder.recordEvent('KTP-flush', { event: 'tick' }, 'localhost');
            }
            expect(JSON.parse(fs.readFileSync(metaPath, 'utf-8')).eventCount).toBe(0);

            // The 100th event triggers a flush.
            recorder.recordEvent('KTP-flush', { event: 'tick' }, 'localhost');
            expect(JSON.parse(fs.readFileSync(metaPath, 'utf-8')).eventCount).toBe(100);

            // Subsequent events (101..199) are buffered again until the next flush at 200.
            for (let i = 0; i < 99; i++) {
                recorder.recordEvent('KTP-flush', { event: 'tick' }, 'localhost');
            }
            expect(JSON.parse(fs.readFileSync(metaPath, 'utf-8')).eventCount).toBe(100);
            recorder.recordEvent('KTP-flush', { event: 'tick' }, 'localhost');
            expect(JSON.parse(fs.readFileSync(metaPath, 'utf-8')).eventCount).toBe(200);
        });
    });

    describe('reapStaleMatches', () => {
        beforeEach(() => {
            jest.useFakeTimers({ doNotFake: ['performance'] });
            jest.setSystemTime(new Date('2026-04-24T12:00:00Z'));
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        it('ends matches with no recent events and leaves active matches alone', () => {
            recorder.startMatch('KTP-reap-A', 'dod_anzio', 1, 1, 'server-a');
            recorder.startMatch('KTP-reap-B', 'dod_flash', 1, 1, 'server-b');

            // Match A keeps receiving events; match B goes silent after start.
            recorder.recordEvent('KTP-reap-A', { event: 'kill' }, 'server-a');
            recorder.recordEvent('KTP-reap-B', { event: 'kill' }, 'server-b');

            // Advance 10 min — both still fresh.
            jest.setSystemTime(new Date('2026-04-24T12:10:00Z'));
            recorder.recordEvent('KTP-reap-A', { event: 'kill' }, 'server-a');

            // Advance to 25 min past start — A's last event is 15 min old (still fresh),
            // B's is 25 min old (stale).
            jest.setSystemTime(new Date('2026-04-24T12:25:00Z'));
            const reaped = recorder.reapStaleMatches(20 * 60 * 1000);

            expect(reaped).toEqual(['KTP-reap-B']);
            expect(recorder.getActiveMatchIds()).toEqual(['KTP-reap-A']);

            const metaB = JSON.parse(
                fs.readFileSync(path.join(tmpDir, 'KTP-reap-B', 'metadata.json'), 'utf-8')
            );
            expect(metaB.endedAt).not.toBeNull();
        });

        it('is idempotent — second call reaps nothing', () => {
            recorder.startMatch('KTP-reap-idem', 'dod_anzio', 1, 1, 'server-a');
            jest.setSystemTime(new Date('2026-04-24T12:30:00Z'));

            const first = recorder.reapStaleMatches(20 * 60 * 1000);
            const second = recorder.reapStaleMatches(20 * 60 * 1000);

            expect(first).toEqual(['KTP-reap-idem']);
            expect(second).toEqual([]);
            expect(recorder.getActiveMatchIds()).toEqual([]);
        });
    });

    describe('multi-match isolation', () => {
        it('keeps back-to-back matches in separate directories with separate event logs', () => {
            recorder.startMatch('KTP-iso-A', 'dod_anzio', 1, 1, 'localhost');
            recorder.recordEvent('KTP-iso-A', { event: 'kill', weapon: 'garand' }, 'localhost');
            recorder.recordEvent('KTP-iso-A', { event: 'flag_captured', flag_id: 0 }, 'localhost');
            recorder.endMatch('KTP-iso-A');

            recorder.startMatch('KTP-iso-B', 'dod_flash', 3, 1, 'localhost');
            recorder.recordEvent('KTP-iso-B', { event: 'kill', weapon: 'mp40' }, 'localhost');
            recorder.endMatch('KTP-iso-B');

            const metaA = JSON.parse(
                fs.readFileSync(path.join(tmpDir, 'KTP-iso-A', 'metadata.json'), 'utf-8')
            );
            const metaB = JSON.parse(
                fs.readFileSync(path.join(tmpDir, 'KTP-iso-B', 'metadata.json'), 'utf-8')
            );

            expect(metaA.map).toBe('dod_anzio');
            expect(metaA.matchType).toBe(1);
            expect(metaA.eventCount).toBe(2);

            expect(metaB.map).toBe('dod_flash');
            expect(metaB.matchType).toBe(3);
            expect(metaB.eventCount).toBe(1);

            const eventsA = recorder.getEvents('KTP-iso-A')!;
            const eventsB = recorder.getEvents('KTP-iso-B')!;

            expect(eventsA.map(e => e.event)).toEqual(['kill', 'flag_captured']);
            expect(eventsB.map(e => e.event)).toEqual(['kill']);
            // Weapon-level spot check — would fail if events bled across match dirs.
            expect(eventsA[0].weapon).toBe('garand');
            expect(eventsB[0].weapon).toBe('mp40');
        });

        it('allows two matches to be active simultaneously (multi-server scenario)', () => {
            // Simulates two game servers posting events concurrently into one recorder.
            recorder.startMatch('KTP-concurrent-1', 'dod_anzio', 1, 1, 'server-a');
            recorder.startMatch('KTP-concurrent-2', 'dod_flash', 2, 1, 'server-b');

            recorder.recordEvent('KTP-concurrent-1', { event: 'e1a' }, 'server-a');
            recorder.recordEvent('KTP-concurrent-2', { event: 'e1b' }, 'server-b');
            recorder.recordEvent('KTP-concurrent-1', { event: 'e2a' }, 'server-a');

            expect(recorder.getActiveMatchIds().sort())
                .toEqual(['KTP-concurrent-1', 'KTP-concurrent-2']);
            expect(recorder.getMetadata('KTP-concurrent-1')!.eventCount).toBe(2);
            expect(recorder.getMetadata('KTP-concurrent-2')!.eventCount).toBe(1);
        });
    });
});
