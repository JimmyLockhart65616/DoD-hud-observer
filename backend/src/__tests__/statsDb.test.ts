/**
 * Contract tests for the hlstatsx read layer. No database is involved — these
 * pin the two things that fail SILENTLY in production if they regress: the
 * read-only guard, and the SteamID format boundary between hlstats and the HUD.
 */
import {
    assertReadOnly, toHlstatsUniqueId, toHudSteamId,
    RECENT_MATCHES, MATCH_PLAYER_STATS, PLAYER_CAREER, FLAG_POSITIONS, POSITION_SAMPLES,
} from '../statsdb/queries';
import * as statsDb from '../statsdb/statsDb';

const ALL_QUERIES: Array<[string, string]> = [
    ['RECENT_MATCHES', RECENT_MATCHES],
    ['MATCH_PLAYER_STATS', MATCH_PLAYER_STATS],
    ['PLAYER_CAREER', PLAYER_CAREER],
    ['FLAG_POSITIONS', FLAG_POSITIONS],
    ['POSITION_SAMPLES', POSITION_SAMPLES],
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
    });
});
