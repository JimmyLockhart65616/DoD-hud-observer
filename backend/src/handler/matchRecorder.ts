import fs from 'fs';
import path from 'path';

const METADATA_FLUSH_INTERVAL = 100;
export const LATE_EVENT_SETTLEMENT_MS = 30_000;

const OFFICIAL_TEAM_SCORE_SOURCE = 'engine-team-score-v1';

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
    startMatch(matchId: string, map: string, matchType: number, half: number, sourceServer: string): boolean {
        if (this.activeMatches.has(matchId)) {
            const existing = this.metadata.get(matchId);
            if (!existing || existing.sourceServer !== sourceServer) {
                console.warn(`[recorder] Rejected start for active match ${matchId}: source server mismatch`);
                return false;
            }
            // Separate plugin POSTs can arrive out of call order. A score
            // baseline may therefore auto-start the recorder before the
            // authoritative lifecycle POST. Repair that placeholder in place:
            // keep its already-appended events, count and earliest startedAt.
            if (existing.endedAt === null && existing.half === 0 && half > 0) {
                if (existing.map !== 'unknown' && existing.map !== map) {
                    console.warn(`[recorder] Rejected placeholder upgrade for ${matchId}: map mismatch`);
                    return false;
                }
                existing.map = map;
                existing.matchType = matchType;
                existing.half = half;
                this.writeMetadata(matchId, existing);
                console.log(`[recorder] Upgraded auto-started match ${matchId} (${map}, half ${half})`);
                return true;
            }
            console.warn(`[recorder] Match ${matchId} already started, ignoring duplicate start`);
            return true;
        }

        // A lifecycle start cannot legitimately arrive after a completed match
        // within the producer's transport timeout. Never reopen or relabel a
        // completed stable match id.
        if (this.getCompletedMetadata(matchId)) {
            console.warn(`[recorder] Match ${matchId} already completed, refusing late start`);
            return false;
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
        return true;
    }

    /**
     * Append an event to the match's JSONL file. Uses appendFileSync for
     * synchronous, reliable writes. Fast enough for typical match event rates
     * (a few events/second in 6v6).
     *
     * If the match hasn't been explicitly started (no ktp_match_start seen),
     * auto-creates it — handles partial recordings and test scenarios.
     */
    recordEvent(matchId: string, event: Record<string, unknown>, sourceServer: string): boolean {
        let completed: MatchMetadata | undefined;
        if (!this.activeMatches.has(matchId)) {
            completed = this.getCompletedMetadata(matchId);
            if (!completed) {
                if (!this.startMatch(matchId, (event.map as string) ?? 'unknown', 0, 0, sourceServer)) {
                    return false;
                }
            }
        }

        const meta = this.metadata.get(matchId);
        if (!meta || meta.sourceServer !== sourceServer) {
            console.warn(`[recorder] Rejected event for ${matchId}: source server mismatch`);
            return false;
        }

        if (completed && !this.isAdmissibleCompletedEvent(completed, event)) {
            console.warn(`[recorder] Rejected late event for completed match ${matchId} (${event.event ?? 'unknown'})`);
            return false;
        }

        const jsonlPath = path.join(this.matchesDir, matchId, 'events.jsonl');
        fs.appendFileSync(jsonlPath, JSON.stringify(event) + '\n');

        meta.eventCount++;

        if (completed) {
            // endMatch already flushed metadata. Every late row must likewise
            // flush immediately so a restart cannot lose the settled count.
            // Preserve endedAt and never add the match back to activeMatches.
            this.writeMetadata(matchId, meta);
            console.log(`[recorder] Appended late event to completed match ${matchId} (${event.event ?? 'unknown'})`);
            return true;
        }

        this.lastEventAt.set(matchId, Date.now());

        // Flush eventCount to metadata.json every 100 events so a hard crash
        // (or a backend restart that races the reaper) doesn't leave the file
        // frozen at 0. Cheap — metadata.json is <1KB and writeFileSync is
        // already used on startMatch/endMatch.
        if (meta.eventCount % METADATA_FLUSH_INTERVAL === 0) {
            this.writeMetadata(matchId, meta);
        }
        return true;
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
     * Socket-only rows intentionally bypass JSONL, but known match ownership
     * still applies. They may flow for an active match only from its bound
     * server, and never flow after completion. Unknown/pub streams retain the
     * pre-existing socket-only behavior because they have no recorder owner.
     */
    canForwardTransientEvent(matchId: string, sourceServer: string): boolean {
        if (this.activeMatches.has(matchId)) {
            const meta = this.metadata.get(matchId);
            return !!meta && meta.sourceServer === sourceServer;
        }
        return !this.getCompletedMetadata(matchId);
    }

    /**
     * Resolve completed metadata from memory or disk without activating it.
     * rehydrateActiveMatches intentionally skips completed matches, but a late
     * async POST must still settle correctly after a backend restart.
     */
    private getCompletedMetadata(matchId: string): MatchMetadata | undefined {
        let meta = this.metadata.get(matchId);
        if (!meta) {
            const metaPath = path.join(this.matchesDir, matchId, 'metadata.json');
            if (!fs.existsSync(metaPath)) return undefined;
            try {
                meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as MatchMetadata;
                this.metadata.set(matchId, meta);
            } catch {
                return undefined;
            }

            if (typeof meta.endedAt === 'string') {
                const eventCount = this.countStoredEvents(matchId);
                if (meta.eventCount !== eventCount) {
                    console.warn(`[recorder] Repaired completed match ${matchId} eventCount ${meta.eventCount} -> ${eventCount}`);
                    meta.eventCount = eventCount;
                    this.writeMetadata(matchId, meta);
                }
            }
        }
        return typeof meta.endedAt === 'string' ? meta : undefined;
    }

    private countStoredEvents(matchId: string): number {
        const jsonlPath = path.join(this.matchesDir, matchId, 'events.jsonl');
        if (!fs.existsSync(jsonlPath)) return 0;
        return fs.readFileSync(jsonlPath, 'utf-8')
            .split('\n')
            .filter(line => line.trim()).length;
    }

    private isAdmissibleCompletedEvent(meta: MatchMetadata, event: Record<string, unknown>): boolean {
        const endedAt = Date.parse(meta.endedAt!);
        const elapsed = Date.now() - endedAt;
        if (!Number.isFinite(endedAt) || elapsed < 0 || elapsed > LATE_EVENT_SETTLEMENT_MS) {
            return false;
        }

        const officialFinal = event.event === 'team_score'
            && event.source === OFFICIAL_TEAM_SCORE_SOURCE
            && event.sample_kind === 'final';
        const matchEndSummary = event.event === 'player_stats_summary'
            && event.reason === 'match_end';
        return officialFinal || matchEndSummary;
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
