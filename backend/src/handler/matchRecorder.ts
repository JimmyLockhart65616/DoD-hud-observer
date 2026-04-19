import fs from 'fs';
import path from 'path';

export interface MatchMetadata {
    matchId: string;
    map: string;
    matchType: number;
    half: number;
    startedAt: string;       // ISO 8601
    endedAt: string | null;
    eventCount: number;
    sourceServer: string;    // IP or hostname of the game server that sent events
}

/**
 * MatchRecorder
 *
 * Manages per-match event storage. Each match gets a directory under `matchesDir`:
 *
 *   matches/{matchId}/
 *     metadata.json   — match info, updated on start/end
 *     events.jsonl    — one JSON object per line, append-only
 *
 * Lifecycle:
 *   1. On first event for a matchId → create dir, write metadata, create jsonl
 *   2. On every event → fs.appendFileSync to events.jsonl (synchronous — avoids
 *      WriteStream buffering race conditions and is fast enough at match event rates)
 *   3. On ktp_match_end → finalize metadata (endedAt + eventCount)
 */
export class MatchRecorder {

    private matchesDir: string;
    private activeMatches: Set<string> = new Set();
    private metadata: Map<string, MatchMetadata> = new Map();

    constructor(matchesDir: string) {
        this.matchesDir = path.resolve(matchesDir);
        fs.mkdirSync(this.matchesDir, { recursive: true });
    }

    /**
     * Start tracking a new match. Called when ktp_match_start arrives.
     */
    startMatch(matchId: string, map: string, matchType: number, half: number, sourceServer: string): void {
        if (this.activeMatches.has(matchId)) {
            console.warn(`[recorder] Match ${matchId} already started, ignoring duplicate start`);
            return;
        }

        const dir = path.join(this.matchesDir, matchId);
        fs.mkdirSync(dir, { recursive: true });

        const meta: MatchMetadata = {
            matchId,
            map,
            matchType,
            half,
            startedAt: new Date().toISOString(),
            endedAt: null,
            eventCount: 0,
            sourceServer,
        };
        this.metadata.set(matchId, meta);
        this.writeMetadata(matchId, meta);

        // Create the file synchronously so it exists immediately
        const jsonlPath = path.join(dir, 'events.jsonl');
        if (!fs.existsSync(jsonlPath)) {
            fs.writeFileSync(jsonlPath, '');
        }

        this.activeMatches.add(matchId);
        console.log(`[recorder] Started match ${matchId} (${map}, half ${half})`);
    }

    /**
     * Append an event to the match's JSONL file. Uses appendFileSync for
     * synchronous, reliable writes. Fast enough for typical match event rates
     * (a few events/second in 6v6).
     *
     * If the match hasn't been explicitly started (no ktp_match_start seen),
     * auto-creates it — handles partial recordings and test scenarios.
     */
    recordEvent(matchId: string, event: Record<string, unknown>, sourceServer: string): void {
        if (!this.activeMatches.has(matchId)) {
            this.startMatch(matchId, (event.map as string) ?? 'unknown', 0, 0, sourceServer);
        }

        const jsonlPath = path.join(this.matchesDir, matchId, 'events.jsonl');
        fs.appendFileSync(jsonlPath, JSON.stringify(event) + '\n');

        const meta = this.metadata.get(matchId)!;
        meta.eventCount++;
    }

    /**
     * Finalize a match. Called when ktp_match_end arrives.
     */
    endMatch(matchId: string): void {
        const meta = this.metadata.get(matchId);
        if (!meta) {
            console.warn(`[recorder] endMatch called for unknown match ${matchId}`);
            return;
        }

        meta.endedAt = new Date().toISOString();
        this.writeMetadata(matchId, meta);
        this.activeMatches.delete(matchId);

        console.log(`[recorder] Ended match ${matchId} (${meta.eventCount} events)`);
    }

    getMetadata(matchId: string): MatchMetadata | undefined {
        return this.metadata.get(matchId);
    }

    getActiveMatchIds(): string[] {
        return [...this.activeMatches];
    }

    getAllMetadata(): MatchMetadata[] {
        return [...this.metadata.values()];
    }

    /**
     * Read all events for a match from its JSONL file.
     * Returns parsed event objects, or null if match dir doesn't exist.
     */
    getEvents(matchId: string): Record<string, unknown>[] | null {
        const jsonlPath = path.join(this.matchesDir, matchId, 'events.jsonl');
        if (!fs.existsSync(jsonlPath)) return null;

        const raw = fs.readFileSync(jsonlPath, 'utf-8');
        return raw
            .split('\n')
            .filter(line => line.trim())
            .map(line => JSON.parse(line));
    }

    /** No-op now (no streams to close), kept for API compatibility. */
    close(): void {
        // no-op: appendFileSync doesn't hold open file descriptors
    }

    /**
     * List completed matches from disk (for the match picker API).
     */
    listStoredMatches(): MatchMetadata[] {
        if (!fs.existsSync(this.matchesDir)) return [];

        const dirs = fs.readdirSync(this.matchesDir, { withFileTypes: true })
            .filter(d => d.isDirectory());

        const results: MatchMetadata[] = [];
        for (const dir of dirs) {
            const metaPath = path.join(this.matchesDir, dir.name, 'metadata.json');
            if (fs.existsSync(metaPath)) {
                try {
                    const raw = fs.readFileSync(metaPath, 'utf-8');
                    results.push(JSON.parse(raw));
                } catch {
                    // skip corrupt files
                }
            }
        }
        return results;
    }

    private writeMetadata(matchId: string, meta: MatchMetadata): void {
        const metaPath = path.join(this.matchesDir, matchId, 'metadata.json');
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
    }
}
