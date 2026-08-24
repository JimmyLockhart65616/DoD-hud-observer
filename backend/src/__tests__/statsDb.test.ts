/**
 * Contract tests for the hlstatsx read layer. No database is involved — these
 * pin the two things that fail SILENTLY in production if they regress: the
 * read-only guard, and the SteamID format boundary between hlstats and the HUD.
 */
import {
    assertReadOnly, toHlstatsUniqueId, toHudSteamId,
    RECENT_MATCHES, MATCH_PLAYER_STATS, PLAYER_CAREER, FLAG_POSITIONS, POSITION_SAMPLES,
    playerCareerBatchSql, MAX_CAREER_BATCH,
    OFFICIAL_MATCH_TYPES,
} from '../statsdb/queries';
import * as statsDb from '../statsdb/statsDb';
import * as fs from 'fs';
import * as path from 'path';

const ALL_QUERIES: Array<[string, string]> = [
    ['RECENT_MATCHES', RECENT_MATCHES],
    ['MATCH_PLAYER_STATS', MATCH_PLAYER_STATS],
    ['PLAYER_CAREER', PLAYER_CAREER],
    ['FLAG_POSITIONS', FLAG_POSITIONS],
    ['POSITION_SAMPLES', POSITION_SAMPLES],
    ['PLAYER_CAREER_BATCH', playerCareerBatchSql(3)],
];

describe('statsdb read-only guard', () => {
    it.each(ALL_QUERIES)('%s is accepted as read-only', (_name, sql) => {
        expect(() => assertReadOnly(sql)).not.toThrow();
    });

    it.each([
        ['UPDATE ktp_match_stats SET kills = 0'],
        ['DELETE FROM ktp_matches'],
        ['DROP TABLE ktp_matches'],
        ['INSERT INTO ktp_matches VALUES (1)'],
        ['TRUNCATE ktp_matches'],
    ])('rejects %s', (sql) => {
        expect(() => assertReadOnly(sql)).toThrow();
    });

    it('rejects a write stacked behind a SELECT', () => {
        expect(() => assertReadOnly('SELECT 1; DROP TABLE ktp_matches')).toThrow();
    });

    it('tolerates a single trailing semicolon', () => {
        expect(() => assertReadOnly('SELECT 1;')).not.toThrow();
    });

    it('is not fooled by a write hidden behind a comment', () => {
        expect(() => assertReadOnly('-- harmless\n DELETE FROM ktp_matches')).toThrow();
    });
});

describe('SteamID format boundary', () => {
    // hlstats_PlayerUniqueIds.uniqueId stores `1:748805`; the HUD's user_id is
    // `STEAM_0:1:748805`. Comparing the raw forms matches nothing at all, which
    // reads exactly like a player with no history rather than like a bug.
    it('strips the STEAM_0: prefix for hlstats', () => {
        expect(toHlstatsUniqueId('STEAM_0:1:748805')).toBe('1:748805');
    });

    it('leaves an already-short id alone', () => {
        expect(toHlstatsUniqueId('1:748805')).toBe('1:748805');
    });

    it('restores the prefix for HUD consumers', () => {
        expect(toHudSteamId('1:748805')).toBe('STEAM_0:1:748805');
    });

    it('does not double-prefix', () => {
        expect(toHudSteamId('STEAM_0:1:748805')).toBe('STEAM_0:1:748805');
    });

    it('round-trips', () => {
        const hud = 'STEAM_0:0:32793027';
        expect(toHudSteamId(toHlstatsUniqueId(hud))).toBe(hud);
    });
});

describe('query shapes', () => {
    // ktp_matches holds ONE ROW PER HALF. Without the GROUP BY, a two-half match
    // appears twice in a "recent matches" list and OT makes it three times.
    it('recent-matches collapses the per-half rows', () => {
        expect(RECENT_MATCHES).toMatch(/GROUP BY\s+m\.match_id/i);
    });

    // Career totals must come from the stored half=0 TOTAL rows only; summing
    // every row would add the halves on top of the total and double every stat.
    it('career totals read only the stored total rows', () => {
        expect(PLAYER_CAREER).toMatch(/s\.half\s*=\s*0/);
    });

    // The batch form is the one the caster page uses, so it must agree with the
    // single-player query on the half=0 filter — a divergence would make the
    // roster panel and a drill-down disagree about the same player.
    it('the career batch keeps the half=0 total filter', () => {
        expect(playerCareerBatchSql(6)).toMatch(/s\.half\s*=\s*0/);
    });

    it('the career batch emits one placeholder per id and binds them', () => {
        expect(playerCareerBatchSql(1)).toMatch(/IN \(\?\)/);
        expect(playerCareerBatchSql(4)).toMatch(/IN \(\?,\?,\?,\?\)/);
    });

    // An unbounded IN list would give back the whole point of batching — one
    // bounded query instead of N — and hand a caller a way to make the shared
    // data server do arbitrary work.
    it('the career batch refuses sizes outside 1..MAX', () => {
        expect(() => playerCareerBatchSql(0)).toThrow(/out of range/);
        expect(() => playerCareerBatchSql(MAX_CAREER_BATCH + 1)).toThrow(/out of range/);
        expect(() => playerCareerBatchSql(2.5)).toThrow(/out of range/);
        expect(() => playerCareerBatchSql(MAX_CAREER_BATCH)).toBeTruthy();
    });

    it('position samples are bounded', () => {
        expect(POSITION_SAMPLES).toMatch(/LIMIT \?/);
    });
});

describe('aggregate coercion', () => {
    // MySQL hands SUM()/COUNT() back as DECIMAL/BIGINT, which the driver
    // stringifies under bigNumberStrings — so an uncoerced career row serialises
    // as {"kills":"70"} and a consumer doing kills+1 gets "701". Confirmed
    // against a seeded MySQL 8 before this test was written.
    it("turns the driver's aggregate strings into numbers", () => {
        const raw = {
            steam_id: '1:748805', name: 'iH. Naes',
            matches: '1', kills: '70', deaths: '49', headshots: '12',
            damage: '8440', team_kills: '1', suicides: '0',
        };
        const out = statsDb.toNumbers(raw, statsDb.CAREER_NUMERIC) as Record<string, unknown>;
        expect(out.kills).toBe(70);
        expect(out.matches).toBe(1);
        expect(out.damage).toBe(8440);
        expect(out.suicides).toBe(0);
    });

    it('leaves non-numeric columns alone', () => {
        const out = statsDb.toNumbers(
            { name: 'iH. Naes', steam_id: '1:748805', kills: '70' },
            statsDb.CAREER_NUMERIC,
        ) as Record<string, unknown>;
        expect(out.name).toBe('iH. Naes');
        // steam_id is NOT in CAREER_NUMERIC — coercing it would turn
        // '1:748805' into NaN and destroy the identity.
        expect(out.steam_id).toBe('1:748805');
    });

    it('does not coerce a value that only looks numeric-ish', () => {
        const out = statsDb.toNumbers({ kills: 'not-a-number' }, ['kills']) as Record<string, unknown>;
        expect(out.kills).toBe('not-a-number');
    });
});

describe('disabled by default', () => {
    // config/local/config.yaml ships stats_db.enabled=false, so a dev laptop and
    // the CI runner must degrade rather than attempt a connection.
    it('reports disabled and returns empty results', async () => {
        expect(statsDb.isEnabled()).toBe(false);
        await expect(statsDb.recentMatches()).resolves.toEqual([]);
        await expect(statsDb.matchPlayerStats('x')).resolves.toEqual([]);
        await expect(statsDb.playerCareer('STEAM_0:1:1')).resolves.toBeNull();
        await expect(statsDb.playerCareers(['STEAM_0:1:1'])).resolves.toEqual({});
    });

    // An empty roster must not reach the database at all — /caster mounts before
    // any player has connected, and a warm-up page should cost nothing.
    it('short-circuits an empty id list', async () => {
        await expect(statsDb.playerCareers([])).resolves.toEqual({});
    });

    // The cap is enforced in the SQL builder too, but failing here gives the
    // route a clean 400 rather than a 502 from deep inside the driver.
    it('refuses a batch larger than the cap', async () => {
        const tooMany = Array.from({ length: MAX_CAREER_BATCH + 1 }, (_, i) => `STEAM_0:0:${i}`);
        await expect(statsDb.playerCareers(tooMany)).rejects.toThrow(/batch cap/);
    });
});

/**
 * League publishing policy, set by the stats owner (Krod, 2026-08-24):
 *   1. 12-man stats are not to be surfaced
 *   2. per-player location / heatmap data is not to be surfaced
 *
 * Both are the kind of rule that is obeyed on the day it is written and
 * quietly broken six months later by an unrelated change, so both are pinned
 * here rather than left to a comment.
 */
describe('publishing policy: match types', () => {
    // An allowlist, not a blocklist. Excluding only 12-man would surface every
    // type added later BY DEFAULT, and the cost of that mistake is publishing
    // exactly what we were asked not to.
    it('allows only official play', () => {
        expect(OFFICIAL_MATCH_TYPES).toEqual([0, 4]);
        expect(OFFICIAL_MATCH_TYPES).not.toContain(2);   // 12MAN
        expect(OFFICIAL_MATCH_TYPES).not.toContain(1);   // SCRIM
        expect(OFFICIAL_MATCH_TYPES).not.toContain(3);   // DRAFT
        expect(OFFICIAL_MATCH_TYPES).not.toContain(5);   // DRAFT_OT
    });

    // Every query that can reach player stats has to carry the filter. A new
    // one added without it is the regression this catches.
    it('constrains match_type on every stats query', () => {
        for (const [name, sql] of [
            ['RECENT_MATCHES', RECENT_MATCHES],
            ['MATCH_PLAYER_STATS', MATCH_PLAYER_STATS],
            ['PLAYER_CAREER', PLAYER_CAREER],
            ['PLAYER_CAREER_BATCH', playerCareerBatchSql(2)],
        ] as Array<[string, string]>) {
            expect(`${name}: ${sql}`).toMatch(/match_type IN \(/);
        }
    });

    // `match_type NOT IN (2)` would drop every NULL row too -- the right result
    // for the wrong reason, and it would start leaking the moment the column is
    // populated. The allowlist form makes the exclusion deliberate.
    it('never expresses the filter as a blocklist', () => {
        for (const sql of [RECENT_MATCHES, MATCH_PLAYER_STATS, PLAYER_CAREER, playerCareerBatchSql(2)]) {
            expect(sql).not.toMatch(/match_type\s+NOT\s+IN/i);
            expect(sql).not.toMatch(/match_type\s*(!=|<>)/i);
        }
    });

    // Production has match_type NULL on every row, so `IN (...)` excludes
    // everything -- which is the correct, conservative answer until the daemon
    // populates it. This test exists so nobody "fixes" the empty result by
    // adding OR match_type IS NULL.
    it('does not readmit NULL match types', () => {
        for (const sql of [RECENT_MATCHES, MATCH_PLAYER_STATS, PLAYER_CAREER, playerCareerBatchSql(2)]) {
            expect(sql).not.toMatch(/match_type\s+IS\s+NULL/i);
        }
    });
});

describe('publishing policy: no location data', () => {
    // The accessor exists for possible future SERVER-SIDE use. What must not
    // exist is a route that hands coordinates to a browser.
    it('exposes no REST route for position samples', () => {
        const app = fs.readFileSync(path.join(__dirname, '..', 'app.ts'), 'utf8');
        expect(app).not.toMatch(/positionSamples/);
        expect(app).not.toMatch(/\/api\/stats\/[^'"`]*position/i);
        expect(app).not.toMatch(/\/api\/stats\/[^'"`]*heatmap/i);
    });

    // Flag positions are MAP GEOMETRY, not player movement -- static per map and
    // identical for everyone. They stay allowed; this records the distinction so
    // the rule above is not read as "no coordinates at all".
    it('still allows static per-map flag coordinates', () => {
        expect(FLAG_POSITIONS).toMatch(/ktp_flag_positions/);
        expect(FLAG_POSITIONS).not.toMatch(/player/i);
    });
});
