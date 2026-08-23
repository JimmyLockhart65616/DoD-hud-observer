/**
 * SQL for the KTPHLStatsX (`hlstatsx`) database, kept separate from the pool so
 * the shapes can be unit-tested without a live server.
 *
 * READ-ONLY BY CONSTRUCTION. Every statement here is a SELECT, the configured
 * user is expected to hold SELECT only, and `assertReadOnly` re-checks at call
 * time. This database is the league's system of record for stats and is written
 * exclusively by the HLStatsX Perl daemon — nothing in this repo may write to it.
 *
 * Traps inherited from KTPHLStatsX's own README, each of which produces a
 * plausible-looking wrong answer rather than an error:
 *
 *  - COLLATION. `hlstats_Events_*` are utf8mb4_unicode_ci while the `ktp_*`
 *    tables are utf8mb4_0900_ai_ci. Joining `match_id` across the two families
 *    without an explicit COLLATE raises "Illegal mix of collations". None of the
 *    queries below cross that boundary; add `COLLATE utf8mb4_unicode_ci` if one
 *    ever does.
 *  - `half` MEANS TWO DIFFERENT THINGS. On `ktp_match_stats`, `half = 0` is the
 *    match TOTAL row, written once at KTP_MATCH_END. On the `hlstats_Events_*`
 *    tables the same value means "the daemon held no match context", i.e. warmup
 *    or between-half activity. Summing `ktp_match_stats` without a half filter
 *    therefore double-counts every figure.
 *  - RECEIPT TIME vs PRODUCER TIME. Event rows are stamped when the daemon
 *    receives them, not when the kill happened, and buffered delivery can cross a
 *    half boundary. Timed analytics belong on `producer_match_id` /
 *    `producer_half` / `event_epoch` where a producer supplies them.
 *  - STEAMID FORMAT. `hlstats_PlayerUniqueIds.uniqueId` holds `1:748805` — no
 *    `STEAM_0:` prefix. The HUD's own `user_id` is the full `STEAM_0:1:748805`.
 *    Use `toHlstatsUniqueId` / `toHudSteamId` to cross that boundary; comparing
 *    the two raw forms silently matches nothing.
 */

/** `STEAM_0:1:748805` (HUD form) -> `1:748805` (hlstats form). */
export function toHlstatsUniqueId(steamId: string): string {
    return String(steamId).replace(/^STEAM_[0-9]+:/i, '');
}

/** `1:748805` (hlstats form) -> `STEAM_0:1:748805` (HUD form). */
export function toHudSteamId(uniqueId: string): string {
    const raw = String(uniqueId);
    return /^STEAM_/i.test(raw) ? raw : `STEAM_0:${raw}`;
}

/**
 * Rejects anything that is not a single read-only statement. Cheap belt-and-
 * braces next to the read-only grant: a stacked statement or a stray write in a
 * future edit fails here rather than reaching a database nobody expects us to
 * write to.
 */
export function assertReadOnly(sql: string): void {
    const stripped = sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
    if (!/^SELECT\b/i.test(stripped)) {
        throw new Error(`statsdb: refusing non-SELECT statement: ${stripped.slice(0, 60)}`);
    }
    // Trailing single `;` is fine; anything after it is a second statement.
    if (/;\s*\S/.test(stripped)) {
        throw new Error('statsdb: refusing stacked statements');
    }
    if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|GRANT|SET)\b/i.test(stripped)) {
        throw new Error('statsdb: refusing statement containing a write keyword');
    }
}

export interface MatchRow {
    match_id: string;
    server_id: number;
    map_name: string;
    half: number;
    match_type: number;
    start_time: string;
    end_time: string | null;
}

export interface PlayerMatchStatRow {
    match_id: string;
    half: number;
    player_id: number;
    name: string;
    steam_id: string;
    kills: number;
    deaths: number;
    headshots: number;
    team_kills: number;
    suicides: number;
    damage: number;
    score: number;
}

/**
 * Recent matches, newest first. `ktp_matches` carries ONE ROW PER HALF, so this
 * groups to one row per match and reports the half count rather than returning
 * the same match two or three times (OT adds 3+).
 */
export const RECENT_MATCHES = `
    SELECT m.match_id,
           MIN(m.server_id)  AS server_id,
           MIN(m.map_name)   AS map_name,
           COUNT(*)          AS halves,
           MIN(m.match_type) AS match_type,
           MIN(m.start_time) AS start_time,
           MAX(m.end_time)   AS end_time
      FROM ktp_matches m
     WHERE m.start_time >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY m.match_id
     ORDER BY start_time DESC
     LIMIT ?
`;

/**
 * One match's box score. `half = 0` is the stored match TOTAL, not a half —
 * callers asking for totals want exactly that row and must not sum the others.
 */
export const MATCH_PLAYER_STATS = `
    SELECT s.match_id, s.half, s.player_id,
           p.lastName AS name,
           u.uniqueId AS steam_id,
           s.kills, s.deaths, s.headshots, s.team_kills, s.suicides,
           s.damage, s.score
      FROM ktp_match_stats s
      JOIN hlstats_Players p        ON p.playerId = s.player_id
      LEFT JOIN hlstats_PlayerUniqueIds u ON u.playerId = s.player_id
     WHERE s.match_id = ?
     ORDER BY s.half, s.kills DESC
`;

/**
 * Career totals for one player across official matches, summed from the stored
 * per-match TOTAL rows (`half = 0`) so it agrees with the box score by
 * construction. Keyed on the hlstats `uniqueId` form — see `toHlstatsUniqueId`.
 */
export const PLAYER_CAREER = `
    SELECT u.uniqueId                AS steam_id,
           MIN(p.lastName)           AS name,
           COUNT(DISTINCT s.match_id) AS matches,
           SUM(s.kills)              AS kills,
           SUM(s.deaths)             AS deaths,
           SUM(s.headshots)          AS headshots,
           SUM(s.damage)             AS damage,
           SUM(s.team_kills)         AS team_kills,
           SUM(s.suicides)           AS suicides
      FROM ktp_match_stats s
      JOIN hlstats_PlayerUniqueIds u ON u.playerId = s.player_id
      JOIN hlstats_Players p         ON p.playerId = s.player_id
     WHERE u.uniqueId = ? AND s.half = 0
     GROUP BY u.uniqueId
`;

/** Static per-flag world coordinates for a map. 2D — dodx exposes no CP_origin_z. */
export const FLAG_POSITIONS = `
    SELECT map_name, flag_index, flag_name, origin_x, origin_y
      FROM ktp_flag_positions
     WHERE map_name = ?
     ORDER BY flag_index
`;

/**
 * Position samples for one match half. Volume is real — roughly one row per
 * alive player per KSC_POSITION_BROADCAST_SECS (5s), so ~2,400 rows for a
 * 12-player half — hence the mandatory LIMIT.
 */
export const POSITION_SAMPLES = `
    SELECT player_id, team, pos_x, pos_y, pos_z, game_time, event_time
      FROM ktp_position_samples
     WHERE match_id = ? AND half = ?
     ORDER BY game_time
     LIMIT ?
`;
