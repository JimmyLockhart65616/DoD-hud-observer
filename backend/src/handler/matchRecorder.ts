import fs from 'fs';
import path from 'path';
import { WriteTimings } from './writeTimings';

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
 *     metadata.json      — match info, updated on start/end
 *     events.jsonl       — one JSON object per line, append-only
 *     player_state.jsonl — the 4 Hz player_state + weapon_active stream, when
 *                          storage.record_player_state is on (see recordPlayerState)
 *
 * Those three names are a contract with KTPInfrastructure's archive retention
 * (scripts/ktp-hud-archive-retention.sh), which leaves any match directory
 * holding a file it does not recognise alone forever. Adding a fourth file
 * means telling Tony first.
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
    private playerStateErrors = 0;

    readonly timings: WriteTimings;

    constructor(matchesDir: string, timings: WriteTimings = new WriteTimings()) {
        this.timings = timings;
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
                // Half stays 0: it marks the placeholder that a later
                // ktp_match_start upgrades, and archive retention keys on it.
                // The type comes from the envelope, which carries it on every
                // event of an active match. 0 is COMPETITIVE, so defaulting to
                // it labelled hundreds of auto-started 12mans and scrims as
                // competitive.
                if (!this.startMatch(matchId, (event.map as string) ?? 'unknown',
                    envelopeMatchType(event.match_type), 0, sourceServer)) {
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
        const line = JSON.stringify(event) + '\n';
        this.timings.time('events', line.length, () => fs.appendFileSync(jsonlPath, line));

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
     * Append a socket-only row (player_state / weapon_active) to the match's
     * player_state.jsonl, so a replay can show what events.jsonl cannot: the
     * weapon in hand, grenades, the wave pills and the scoring tick.
     *
     * Only into an ACTIVE match owned by `sourceServer`. It never auto-starts a
     * match (a stream that only ever sent player_state is not a match) and never
     * writes after completion. It does not refresh lastEventAt either: a server
     * idling in a dead match still sends 4 Hz state, and the reaper must still
     * end it.
     *
     * Positions are dropped before writing. Every replay route is public, and
     * individual coordinates and movement histories stay private (see app.ts);
     * nothing a replay shows needs them.
     *
     * A failed write is logged and swallowed. This is an optional record riding
     * on the live path, and it must never cost the broadcast a POST.
     */
    recordPlayerState(matchId: string, event: Record<string, unknown>, sourceServer: string): boolean {
        if (!this.activeMatches.has(matchId)) return false;
        const meta = this.metadata.get(matchId);
        if (!meta || meta.sourceServer !== sourceServer) return false;

        const line = JSON.stringify(withoutPositions(event)) + '\n';
        const filePath = path.join(this.matchesDir, matchId, 'player_state.jsonl');
        try {
            this.timings.time('player_state', line.length, () => fs.appendFileSync(filePath, line));
            return true;
        } catch (err) {
            this.playerStateErrors++;
            if (this.playerStateErrors === 1 || this.playerStateErrors % 1000 === 0) {
                console.error(`[recorder] player_state write failed (${this.playerStateErrors} so far): ${(err as Error).message}`);
            }
            return false;
        }
    }

    /**
     * The raw text of a match's player_state.jsonl, or null when it has none
     * (recorded before the stream was persisted, or with
     * storage.record_player_state off). Async and unparsed: a full match is
     * ~12-15 MB and the route parses it in slices so the event loop is never
     * held for the whole file.
     */
    async readPlayerState(matchId: string): Promise<string | null> {
        try {
            return await fs.promises.readFile(path.join(this.matchesDir, matchId, 'player_state.jsonl'), 'utf-8');
        } catch {
            return null;
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

    /**
     * The server a match was recorded from, from memory or its metadata.json.
     * Unlike getMetadata, this also answers for a stored match this process
     * has not touched since it started.
     */
    getSourceServer(matchId: string): string | undefined {
        const inMemory = this.metadata.get(matchId);
        if (inMemory) return inMemory.sourceServer;
        try {
            const raw = fs.readFileSync(path.join(this.matchesDir, matchId, 'metadata.json'), 'utf-8');
            const source = (JSON.parse(raw) as Partial<MatchMetadata>).sourceServer;
            return typeof source === 'string' ? source : undefined;
        } catch {
            return undefined;
        }
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

/** The envelope's match_type when it is one the plugin defines (0-5), else 0. */
function envelopeMatchType(value: unknown): number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5 ? value : 0;
}

function withoutPositions(event: Record<string, unknown>): Record<string, unknown> {
    if (!Array.isArray(event.players)) return event;
    return {
        ...event,
        players: (event.players as unknown[]).map(p => {
            if (!p || typeof p !== 'object') return p;
            const { x: _x, y: _y, ...rest } = p as Record<string, unknown>;
            return rest;
        }),
    };
}
