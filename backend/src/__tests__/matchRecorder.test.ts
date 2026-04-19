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
});
