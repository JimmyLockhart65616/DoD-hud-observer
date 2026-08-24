/**
 * Read-only client for the KTPHLStatsX (`hlstatsx`) MySQL database.
 *
 * DISABLED BY DEFAULT. `stats_db.enabled` is false in config/local/config.yaml
 * because the database binds 127.0.0.1 on the data server and does not exist on
 * a dev laptop. Every accessor below returns `null`/`[]` when disabled, so the
 * REST layer can degrade to a 503 instead of throwing on machines without it.
 *
 * Production runs the backend on that same host, so this is a local socket
 * connection — no tunnel, unlike the site's `ktp-stats-export.py` push path,
 * which exists precisely because a remote puller could not reach this port.
 *
 * The configured user must hold SELECT and nothing else; `assertReadOnly`
 * re-checks every statement at call time. See `queries.ts` for the collation,
 * `half`-semantics, receipt-vs-producer-time and SteamID-format traps.
 */
import config from '../config';
import {
    assertReadOnly, withExecutionCap, MAX_EXECUTION_TIME_MS,
    RECENT_MATCHES, MATCH_PLAYER_STATS, PLAYER_CAREER,
    FLAG_POSITIONS, POSITION_SAMPLES,
    playerCareerBatchSql, MAX_CAREER_BATCH,
    toHlstatsUniqueId, toHudSteamId,
    type MatchRow, type PlayerMatchStatRow,
} from './queries';

/**
 * The slice of `mysql2/promise`'s Pool we actually use.
 *
 * Declared locally rather than imported from the package: mysql2's shipped .d.ts
 * references `Symbol.asyncDispose` and `node:diagnostics_channel`, which need a
 * newer `lib`/@types/node than this backend targets (es6), and pulling them in
 * fails the build with a dozen errors from inside node_modules. Since the driver
 * is already loaded through a lazy `require` so the backend can boot without it,
 * depending on its types at compile time would be the odd part.
 */
interface Pool {
    query(
        options: string | { sql: string; values?: unknown[]; timeout?: number },
        params?: unknown[],
    ): Promise<[unknown, unknown]>;
    end(): Promise<void>;
}

let pool: Pool | null = null;
let poolFailed = false;

export function isEnabled(): boolean {
    return config.stats_db.enabled;
}

/**
 * Lazily builds the pool. `require`d rather than imported at module scope so a
 * deployment without the driver installed still boots the rest of the backend —
 * this is an additive read surface, never a startup dependency.
 */
function getPool(): Pool | null {
    if (!isEnabled() || poolFailed) return null;
    if (pool) return pool;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mysql = require('mysql2/promise');
        const c = config.stats_db;
        pool = mysql.createPool({
            host: c.host,
            port: c.port,
            user: c.user,
            password: c.password,
            database: c.database,
            connectionLimit: c.connection_limit,
            connectTimeout: c.timeout_ms,
            // Never let requests QUEUE for a connection. A queue on a shared,
            // busy database converts a slow patch into an unbounded backlog and
            // a memory leak; with queueLimit 1 and waitForConnections false the
            // pool errors immediately and the guard sheds the request instead.
            waitForConnections: false,
            queueLimit: 1,
            // Keep the footprint on the shared server small and short-lived.
            idleTimeout: 30_000,
            maxIdle: 1,
            // Keep DECIMAL/BIGINT as strings rather than silently losing
            // precision; callers coerce what they actually need.
            decimalNumbers: false,
            supportBigNumbers: true,
            bigNumberStrings: true,
            // Defence in depth against the stacked-statement shape that
            // assertReadOnly also rejects.
            multipleStatements: false,
        }) as Pool;
        return pool;
    } catch (err) {
        poolFailed = true;
        console.error('[statsdb] pool unavailable, stats endpoints will 503:', (err as Error).message);
        return null;
    }
}

/**
 * The single choke point every stats read goes through.
 *
 * Applies, in order: the read-only assertion, the MySQL-side MAX_EXECUTION_TIME
 * hint, and a client-side timeout. Centralised deliberately — a query added
 * later inherits all three rather than having to remember them.
 */
async function query<T>(sql: string, params: unknown[]): Promise<T[]> {
    assertReadOnly(sql);
    const p = getPool();
    if (!p) return [];
    const capped = withExecutionCap(sql);
    // Client timeout sits ABOVE the server-side cap so MySQL gets the chance to
    // kill its own statement first — that way the database reclaims the work
    // rather than us abandoning a query that keeps running.
    const [rows] = await p.query({
        sql: capped,
        values: params,
        timeout: MAX_EXECUTION_TIME_MS + 1000,
    });
    return rows as T[];
}

/**
 * MySQL returns SUM()/COUNT() as DECIMAL/BIGINT, which the driver hands back as
 * a STRING under `bigNumberStrings` — so an untouched career row serialises as
 * `"kills": "70"` and any arithmetic a consumer does on it silently concatenates.
 * Kill counts and match totals are far inside Number's safe range, so coerce the
 * known-numeric columns here rather than leaving every caller to remember.
 */
export function toNumbers<T extends object>(row: T, keys: string[]): T {
    const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
    for (const k of keys) {
        if (typeof out[k] === 'string' && out[k] !== '') {
            const n = Number(out[k]);
            if (!Number.isNaN(n)) out[k] = n;
        }
    }
    return out as T;
}

export const CAREER_NUMERIC = ['matches', 'kills', 'deaths', 'headshots', 'damage', 'team_kills', 'suicides'];

export async function recentMatches(days = 30, limit = 50): Promise<MatchRow[]> {
    const rows = await query<MatchRow>(RECENT_MATCHES, [days, limit]);
    return rows.map(r => toNumbers(r, ['halves', 'server_id', 'match_type']));
}

/**
 * One match's rows, with SteamIDs normalised to the HUD's `STEAM_0:` form so a
 * caller can join these straight onto live overlay state without knowing that
 * hlstats stores the short form.
 */
export async function matchPlayerStats(matchId: string): Promise<PlayerMatchStatRow[]> {
    const rows = await query<PlayerMatchStatRow>(MATCH_PLAYER_STATS, [matchId]);
    return rows.map(r => ({ ...r, steam_id: r.steam_id ? toHudSteamId(r.steam_id) : '' }));
}

export async function playerCareer(steamId: string): Promise<Record<string, unknown> | null> {
    const rows = await query<Record<string, unknown>>(PLAYER_CAREER, [toHlstatsUniqueId(steamId)]);
    if (!rows.length) return null;
    const row = toNumbers(rows[0], CAREER_NUMERIC);
    return { ...row, steam_id: toHudSteamId(String(row.steam_id ?? steamId)) };
}

/**
 * Career totals for a whole roster in ONE query.
 *
 * The reason this exists rather than the caster page looping over
 * `playerCareer`: twelve round trips would be twelve connections' worth of work
 * on a data server that also runs MySQL for the league, the HLStatsX daemon, the
 * HLTV proxies and this backend. One statement, one cache entry, one rate-limit
 * token.
 *
 * Returns a MAP keyed by the HUD-form SteamID. Players with no recorded matches
 * are absent rather than zero-filled — "never played a league match" and "played
 * and scored nothing" are different facts and the caller renders them
 * differently. Duplicate and over-limit inputs are the caller's problem to avoid;
 * ids are de-duplicated here and the batch cap is enforced in the SQL builder.
 */
export async function playerCareers(steamIds: string[]): Promise<Record<string, Record<string, unknown>>> {
    const unique = Array.from(new Set(steamIds.map(toHlstatsUniqueId).filter(Boolean)));
    if (!unique.length) return {};
    if (unique.length > MAX_CAREER_BATCH) {
        throw new Error(`statsdb: ${unique.length} ids exceeds the ${MAX_CAREER_BATCH} career batch cap`);
    }

    const rows = await query<Record<string, unknown>>(playerCareerBatchSql(unique.length), unique);
    const out: Record<string, Record<string, unknown>> = {};
    for (const raw of rows) {
        const row = toNumbers(raw, CAREER_NUMERIC);
        const steam = toHudSteamId(String(row.steam_id ?? ''));
        out[steam] = { ...row, steam_id: steam };
    }
    return out;
}

export async function flagPositions(mapName: string): Promise<Record<string, unknown>[]> {
    return query<Record<string, unknown>>(FLAG_POSITIONS, [mapName]);
}

export async function positionSamples(matchId: string, half: number, limit = 5000) {
    return query<Record<string, unknown>>(POSITION_SAMPLES, [matchId, half, limit]);
}

/** Test seam — drops the memoised pool so config changes take effect. */
export function __resetPoolForTests(): void {
    pool = null;
    poolFailed = false;
}
