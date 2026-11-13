import zlib from 'zlib';
import { promisify } from 'util';
import type { Request, Response } from 'express';
import type { MatchRecorder } from './matchRecorder';
import { pseudonymize } from './pseudonym';

const gzip = promisify(zlib.gzip);

// Match ids are what the plugin stamps (`<epoch>-<SERVER>`, or a mocker/test
// id). Anything else is refused before it can reach a filesystem path.
const MATCH_ID_RE = /^[\w.-]+$/;

export function isSafeMatchId(matchId: string): boolean {
    return MATCH_ID_RE.test(matchId) && !matchId.includes('..');
}

/**
 * Pseudonym scope for a recorded match. Both replay routes MUST use this one
 * function: the replay joins player_state rows to events by user_id, so the two
 * streams of one match have to mint identical tokens.
 */
export function replayScope(recorder: MatchRecorder, matchId: string): string {
    return recorder.getSourceServer(matchId) ?? matchId;
}

// A finished match's player_state is immutable, and the first build of its
// response (parse, pseudonymize, stringify, gzip ~12-15 MB) is the expensive
// part, so the gzipped body is kept for the few most recently requested matches.
const CACHE_MAX = 3;

// The build runs on the same event loop as live ingest and the socket fan-out.
// Done in one pass it held the loop for ~210 ms on a 10k-row match (measured
// locally), which on prod is every server's broadcast stalling at once because
// somebody opened a replay. In slices of this many rows, with a yield between,
// no slice holds it for more than a few milliseconds.
const ROWS_PER_SLICE = 500;
const yieldToLoop = () => new Promise<void>(resolve => setImmediate(resolve));

/**
 * GET /api/matches/:matchId/player_state — the match's player_state.jsonl rows,
 * pseudonymized, as `{ events: [...] }`, gzipped when the client accepts it.
 * 404 when the match has no such file.
 *
 * PUBLIC AND UNAUTHENTICATED, like every /api route. Positions were never
 * written (MatchRecorder.recordPlayerState drops them) and ids leave as tokens.
 * Compact JSON rather than the app's pretty-printed default: indentation alone
 * would add megabytes.
 */
export function createPlayerStateHandler(recorder: MatchRecorder) {
    const cache = new Map<string, Buffer>();
    const inFlight = new Map<string, Promise<Buffer | null>>();

    async function build(matchId: string): Promise<Buffer | null> {
        const raw = await recorder.readPlayerState(matchId);
        if (raw === null) return null;
        const scope = replayScope(recorder, matchId);
        const lines = raw.split('\n');
        const parts: string[] = [];
        for (let i = 0; i < lines.length; i += ROWS_PER_SLICE) {
            const slice: string[] = [];
            for (const line of lines.slice(i, i + ROWS_PER_SLICE)) {
                if (!line.trim()) continue;
                let row: unknown;
                try { row = JSON.parse(line); } catch { continue; }   // a torn final line from a crash
                slice.push(JSON.stringify(pseudonymize(row, scope)));
            }
            if (slice.length) parts.push(slice.join(','));
            await yieldToLoop();
        }
        return gzip(`{"events":[${parts.join(',')}]}`);
    }

    return async (req: Request, res: Response): Promise<void> => {
        const matchId = req.params.matchId;
        if (!isSafeMatchId(matchId)) {
            res.status(400).json({ error: 'bad match id' });
            return;
        }

        let body = cache.get(matchId) ?? null;
        if (!body) {
            let pending = inFlight.get(matchId);
            if (!pending) {
                pending = build(matchId).finally(() => inFlight.delete(matchId));
                inFlight.set(matchId, pending);
            }
            body = await pending;
            if (!body) {
                res.status(404).json({ error: 'no player_state recorded for this match' });
                return;
            }
            // Only a finished match is immutable; a live one keeps growing.
            if (!recorder.getActiveMatchIds().includes(matchId)) {
                cache.delete(matchId);
                cache.set(matchId, body);
                while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
            }
        } else {
            cache.delete(matchId);      // most recently used goes to the back
            cache.set(matchId, body);
        }

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Vary', 'Accept-Encoding');
        if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
            res.setHeader('Content-Encoding', 'gzip');
            res.end(body);
        } else {
            res.end(zlib.gunzipSync(body));
        }
    };
}
