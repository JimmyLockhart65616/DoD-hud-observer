import fs from 'fs';
import path from 'path';

const METADATA_FLUSH_INTERVAL = 100;

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
    // In-memory only — tracks wall-clock of last recorded event per active match,
    // used by reapStaleMatches. Not persisted to metadata.json.
    private lastEventAt: Map<string, number> = new Map();

    constructor(matchesDir: string) {
        this.matchesDir = path.resolve(matchesDir);
        fs.mkdirSync(this.matchesDir, { recursive: true });
        this.rehydrateActiveMatches();
    }

    /**
     * On startup, scan the matches dir for any match whose metadata.json has
     * `endedAt: null` and pull it back into `activeMatches` / `metadata` /
     * `lastEventAt`. Without this, a backend restart strands every match that
     * was active at restart time — `recordEvent`'s eventCount increments live
     * in memory only, so its metadata.json is frozen at the value `startMatch`
     * wrote (`0`), and the reaper can't see it because activeMatches is empty.
     *
     * `eventCount` is recovered by counting lines in events.jsonl (cheap — a
     * full match is a few thousand lines). `lastEventAt` is seeded from the
     * jsonl's mtime, so already-stale orphans get reaped on the next tick.
     */
    private rehydrateActiveMatches(): void {
        if (!fs.existsSync(this.matchesDir)) return;

        const dirs = fs.readdirSync(this.matchesDir, { withFileTypes: true })
            .filter(d => d.isDirectory());

        let count = 0;
        for (const dir of dirs) {
            const matchId = dir.name;
            const metaPath = path.join(this.matchesDir, matchId, 'metadata.json');
            if (!fs.existsSync(metaPath)) continue;

            let meta: MatchMetadata;
            try {
                meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            } catch {
                continue;
            }
            if (meta.endedAt !== null) continue;

            const jsonlPath = path.join(this.matchesDir, matchId, 'events.jsonl');
            let eventCount = 0;
            let lastEventAt = Date.now();
            if (fs.existsSync(jsonlPath)) {
                const raw = fs.readFileSync(jsonlPath, 'utf-8');
                eventCount = raw.split('\n').filter(l => l.trim()).length;
                lastEventAt = fs.statSync(jsonlPath).mtimeMs;
            }
            meta.eventCount = eventCount;

            this.metadata.set(matchId, meta);
            this.activeMatches.add(matchId);
            this.lastEventAt.set(matchId, lastEventAt);
            count++;
        }

        if (count > 0) {
            console.log(`[recorder] Rehydrated ${count} active match(es) from disk`);
        }
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
        this.lastEventAt.set(matchId, Date.now());
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
        this.lastEventAt.set(matchId, Date.now());

        // Flush eventCount to metadata.json every 100 events so a hard crash
        // (or a backend restart that races the reaper) doesn't leave the file
        // frozen at 0. Cheap — metadata.json is <1KB and writeFileSync is
        // already used on startMatch/endMatch.
        if (meta.eventCount % METADATA_FLUSH_INTERVAL === 0) {
            this.writeMetadata(matchId, meta);
        }
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
        this.lastEventAt.delete(matchId);

        console.log(`[recorder] Ended match ${matchId} (${meta.eventCount} events)`);
    }

    /**
     * End any active match whose most recent event is older than `staleMs`.
     * Safety net for matches that never get a clean `ktp_match_end` — plugin
     * reloads, changelevels, crashes, or rcon restarts all leave ghosts in
     * `activeMatches` that would otherwise sit forever.
     *
     * Returns the list of reaped match ids (for logging / observability).
     */
    reapStaleMatches(staleMs: number): string[] {
        const now = Date.now();
        const reaped: string[] = [];
        for (const id of this.activeMatches) {
            const last = this.lastEventAt.get(id) ?? 0;
            const idle = now - last;
            if (idle > staleMs) {
                console.log(`[recorder] Reaping stale match ${id} (idle ${Math.round(idle / 1000)}s)`);
                this.endMatch(id);
                reaped.push(id);
            }
        }
        return reaped;
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
