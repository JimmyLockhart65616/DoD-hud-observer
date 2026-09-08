/**
 * Player-identity pseudonymization at the publication boundary.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every outbound surface this backend serves is public and unauthenticated —
 * `/api/hq`, `/socket.io/` and `/api/matches/:id/events` all answer 200 to
 * anyone who asks (JimmyLockhart65616/DoD-hud-observer#19, measured against the
 * live deployment 2026-09-04). They carried raw SteamIDs alongside in-game
 * names and K/D, which is the league's own roster: of the 12 ids in the most
 * recent stored match, 12/12 resolved to league player records.
 *
 * So real SteamIDs stop at the boundary. Internally — the state cache, the
 * MatchRecorder's events.jsonl on disk, the league stats join — nothing
 * changes; those are operator-owned and are exactly where the real id is
 * needed. What crosses the wire is an opaque token minted here.
 *
 * THE ONE PROPERTY THAT MAKES THIS CHEAP
 * --------------------------------------
 * The frontend already treats `user_id` as an opaque token. Every one of the
 * ~79 uses in Socket.jsx is a React `key=` or a dictionary lookup
 * (`byId[r.user_id]`, `findIndex(p => p.user_id === id)`); the SteamID is never
 * parsed and never displayed. Swapping the string for another stable string is
 * invisible to the render path.
 *
 * The single consumer that needed the real value — /caster's League Career
 * panel — does its join through OUR OWN backend (`/api/stats/players?ids=`),
 * so the resolution moves server-side (see resolvePlayerId) and the browser
 * never needs a SteamID at all. It was only ever passing a token through.
 *
 * SCOPE = SERVER HOSTNAME, NOT MATCH ID
 * -------------------------------------
 * The obvious choice is a per-match id, but it breaks the surfaces that
 * legitimately outlive a match. The per-server state cache is never evicted and
 * keys on the id, `/hq` shows rosters on servers with no match running at all
 * (BETWEEN/WARMUP), and a `server:<host>` socket room streams continuously
 * across match boundaries. Scoping per match would re-mint every id at each
 * boundary and make the same player read as a new one.
 *
 * Server scope means the same player carries one token for as long as this
 * process lives, on that server. That is deliberate and is not the leak being
 * closed: the token resolves to an identity only through the in-process map
 * below, which never crosses the wire.
 *
 * THE SECRET
 * ----------
 * `HUD_PSEUDONYM_SECRET` if set, otherwise 32 random bytes per boot. The
 * random default is the safe one: tokens become unguessable and unlinkable
 * across restarts with zero operator setup, and `config/online/config.yaml` is
 * gitignored and operator-owned, so requiring a config edit would mean a
 * deploy that silently degrades until someone remembers. Set the env var only
 * if you need tokens stable across a restart.
 *
 * Rotation on restart costs nothing operationally: a restart drops every
 * socket, so clients rebuild their rosters from the reconnect snapshot anyway.
 * A career lookup that raced the restart resolves to nothing, which the batch
 * route already treats as "no record" rather than an error.
 */

import crypto from 'crypto';

const SECRET: Buffer = process.env.HUD_PSEUDONYM_SECRET
    ? Buffer.from(process.env.HUD_PSEUDONYM_SECRET, 'utf8')
    : crypto.randomBytes(32);

/**
 * 16 hex chars = 64 bits. Long enough that a collision across every player the
 * fleet will ever see is not worth reasoning about, short enough to stay
 * readable in a devtools payload.
 */
const TOKEN_HEX = 16;

/**
 * Derivation key for a token: the scope length-prefixed, then the id.
 *
 * Length-prefixed rather than joined with a separator so no (scope, id) pair
 * can collide with a different one by moving the boundary — a hostname is
 * operator-supplied and a SteamID is plugin-supplied, so no single character
 * is guaranteed absent from both.
 */
function derivationKey(scope: string, realId: string): string {
    return `${scope.length}:${scope}${realId}`;
}

/** derivationKey() to token. */
const forward = new Map<string, string>();
/** token to realId. The only path back, and it never leaves this process. */
const reverse = new Map<string, string>();

/**
 * Scalar fields naming exactly one player. Enumerated rather than pattern-
 * matched on `*_id`: `match_id`, `flag_id` and `class_id` all end in `_id` and
 * none of them is a player. A regex here would corrupt the flag bar and the
 * class icons while looking like it was doing the right thing.
 */
const SCALAR_ID_FIELDS = new Set([
    'user_id', 'killer_id', 'victim_id', 'attacker_id', 'breaker_id',
    // Not a live-overlay field: this is the league stats DB's own column, on the
    // rows /api/stats/matches/:matchId serves. It was publishing real SteamIDs
    // with names and full stats on a public route long after the socket and HQ
    // surfaces were closed — the identity leak of #19 simply reached the wire by
    // a different name. Listed here so the walker covers any stats payload too.
    'steam_id',
]);

/** Fields holding an array of player ids. */
const ARRAY_ID_FIELDS = new Set([
    'assist_ids', 'captor_ids', 'contester_ids',
]);

/**
 * Mint (or recall) the public token for one real player id on one server.
 *
 * Deterministic per (scope, realId) for the life of the process, so a token is
 * stable across every surface within one response and across responses.
 */
export function mintPlayerId(realId: string, scope: string): string {
    if (typeof realId !== 'string' || realId === '') return realId;

    const key = derivationKey(scope, realId);
    const hit = forward.get(key);
    if (hit) return hit;

    const token = 'p_' + crypto.createHmac('sha256', SECRET)
        .update(key)
        .digest('hex')
        .slice(0, TOKEN_HEX);

    forward.set(key, token);
    reverse.set(token, realId);
    return token;
}

/**
 * Token to real SteamID, or undefined if this process never minted it (an id
 * from before a restart, or one somebody made up).
 *
 * Callers must treat undefined as "no such player" and omit it, never as an
 * error: the batch career route's contract is already that an absent id means
 * "no league match recorded", so a stale token degrades into the path that
 * already exists.
 */
export function resolvePlayerId(token: string): string | undefined {
    return reverse.get(token);
}

/**
 * Resolve a batch, dropping what does not resolve. Order is not preserved and
 * duplicates collapse — callers key the result by id, never by position.
 */
export function resolvePlayerIds(tokens: string[]): string[] {
    const out = new Set<string>();
    for (const t of tokens) {
        const real = reverse.get(t);
        if (real !== undefined) out.add(real);
    }
    return [...out];
}

/**
 * Deep-copy `value`, replacing every player id with its token.
 *
 * Recursive rather than a field-by-field rewrite of each event shape, because
 * ids also live nested — `players[].user_id` inside `player_stats_summary` and
 * `player_state`, `assist_ids` inside a `kill`. A walker covers those without
 * enumerating the schema, and covers whatever the plugin adds next as long as
 * it reuses one of the field names above.
 *
 * The input is never mutated: the caller's copy feeds the state cache and the
 * recorder, both of which must keep the real ids.
 */
export function pseudonymize<T>(value: T, scope: string): T {
    return walk(value, scope) as T;
}

function walk(value: any, scope: string): any {
    if (Array.isArray(value)) return value.map(v => walk(v, scope));
    if (value === null || typeof value !== 'object') return value;

    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
        if (SCALAR_ID_FIELDS.has(k) && typeof v === 'string') {
            out[k] = mintPlayerId(v, scope);
        } else if (ARRAY_ID_FIELDS.has(k) && Array.isArray(v)) {
            out[k] = v.map(id => typeof id === 'string' ? mintPlayerId(id, scope) : id);
        } else {
            out[k] = walk(v, scope);
        }
    }
    return out;
}

/**
 * Re-key a SteamID-keyed lookup by token for publication.
 *
 * The return half of the career round-trip: a caller resolves tokens to real
 * ids, queries with those, then hands the result back through here so the reply
 * speaks only in tokens.
 *
 * `steam_id` inside each row is REWRITTEN, not just re-keyed. The career row
 * carries the id in its body as well as in its key, so re-keying alone would put
 * the SteamID straight back on the wire in a field nobody was looking at — the
 * same shape of mistake as the display-name fallback in ingest.ts.
 *
 * Rows with no match are omitted; the reply is a map and an absent key already
 * means "no league record", which is rendered differently from a zero.
 */
export function rekeyByToken<T extends Record<string, any>>(
    bySteamId: Record<string, T>,
    pairs: { token: string; steam: string }[],
): Record<string, T> {
    const out: Record<string, T> = {};
    for (const { token, steam } of pairs) {
        const row = bySteamId[steam];
        if (!row) continue;
        out[token] = ('steam_id' in row) ? { ...row, steam_id: token } : row;
    }
    return out;
}

/** Test/diagnostic only — never serialized to a response. */
export function _mintedCount(): number {
    return reverse.size;
}
