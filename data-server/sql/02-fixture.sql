-- Synthetic fixture for the local `hlstatsx` database.
--
-- EVERY PLAYER, STEAMID AND SCORE BELOW IS INVENTED. No real league player data
-- is committed to this repo -- it is not ours to redistribute, and a developer
-- spinning up the stack has no need of it. The SteamIDs sit in a reserved-looking
-- 9:1000000+ band so they cannot collide with a real account.
--
-- Applied idempotently by data-server/start.sh (INSERT IGNORE over a fixed id
-- space), so re-running is a no-op rather than a duplicate.
--
-- SHAPED TO EXERCISE THE TRAPS, not merely to be non-empty:
--
--   * halves 0/1/2 present, where half=0 is the stored match TOTAL and the
--     per-half rows sum to exactly it. A consumer that sums every row gets
--     precisely double -- which is the bug this shape is here to catch.
--   * one match still IN PROGRESS (end_time NULL, half 1 only, and no half=0
--     row yet because that is written at KTP_MATCH_END), so the GROUP BY in
--     RECENT_MATCHES is exercised against a partial match.
--   * one match with damage = 0 for everyone. This is NOT filler: it reproduces
--     the live production condition where ktp_match_stats.damage derives solely
--     from ktp_damage_events, which only one instance in the fleet produces, so
--     every other server records a measured zero (KTPHLStatsX issue #33). Build
--     consumers against that reality, not against a tidy world.
--   * a name containing an apostrophe, which broke the first export of this data
--     (mysql -N escapes backslashes in its output; --raw is required) and will
--     break any naive quoting downstream.
--   * two maps of flag coordinates, whose flag_index is dodx SPAWN order and NOT
--     geographic -- which is why consumers must key on flag_name.

-- ---------------------------------------------------------------- players
INSERT IGNORE INTO hlstats_Players (playerId, lastName) VALUES
  (9001, 'Sgt. Sourdough'),      (9002, 'crumpet'),
  (9003, 'O''Brien the Loud'),   (9004, 'panzer_pigeon'),
  (9005, '[bb] tinned_peaches'), (9006, 'Marguerite'),
  (9007, 'nine volt'),           (9008, 'HEDGEHOG'),
  (9009, 'quiet bill'),          (9010, 'Ada L.'),
  (9011, 'trench_broom'),        (9012, 'the milkman');

-- The uniqueIds deliberately match the MOCKER's roster (backend/src/mocker/data.ts:
-- STEAM_0:0:1001-1006 allies, STEAM_0:0:2001-2006 axis), minus the "STEAM_0:"
-- prefix that hlstats does not store. That alignment is what makes the whole
-- chain testable on one machine: run the mocker and every player on /caster has
-- a career row to look up. Break it and the panel goes correctly but uselessly
-- blank, which looks identical to the read layer being broken.
--
-- The display names below are NOT the mocker's, on purpose. The panel keys on
-- SteamID and labels rows from the live HUD roster, so a name that disagrees with
-- the feed proves the join is on the id and not on a name match.
INSERT IGNORE INTO hlstats_PlayerUniqueIds (playerId, uniqueId, game) VALUES
  (9001,'0:1001','dod'), (9002,'0:1002','dod'), (9003,'0:1003','dod'),
  (9004,'0:1004','dod'), (9005,'0:1005','dod'), (9006,'0:1006','dod'),
  (9007,'0:2001','dod'), (9008,'0:2002','dod'), (9009,'0:2003','dod'),
  (9010,'0:2004','dod'), (9011,'0:2005','dod'), (9012,'0:2006','dod');

-- ---------------------------------------------------------------- matches
-- Relative to NOW() so the default days=30 window always finds them, however
-- long after this file was written the stack is started.
INSERT IGNORE INTO ktp_matches (match_id, server_id, map_name, half, match_type, start_time, end_time) VALUES
  ('LOCAL-0001-DEV1', 1, 'dod_anzio',       1, 0, NOW() - INTERVAL 3 DAY,                      NOW() - INTERVAL 3 DAY + INTERVAL 20 MINUTE),
  ('LOCAL-0001-DEV1', 1, 'dod_anzio',       2, 0, NOW() - INTERVAL 3 DAY + INTERVAL 23 MINUTE, NOW() - INTERVAL 3 DAY + INTERVAL 43 MINUTE),
  ('LOCAL-0002-DEV1', 1, 'dod_donner',      1, 1, NOW() - INTERVAL 2 DAY,                      NOW() - INTERVAL 2 DAY + INTERVAL 20 MINUTE),
  ('LOCAL-0002-DEV1', 1, 'dod_donner',      2, 1, NOW() - INTERVAL 2 DAY + INTERVAL 22 MINUTE, NOW() - INTERVAL 2 DAY + INTERVAL 42 MINUTE),
  ('LOCAL-0003-DEV2', 2, 'dod_saints2_b3e', 1, 0, NOW() - INTERVAL 10 MINUTE,                  NULL),
  -- match_type 2 = 12MAN. Its player stats must NEVER reach the API (league
  -- policy, Krod 2026-08-24). Deliberately given the BIGGEST numbers in the
  -- fixture so a regression that leaks them is loud rather than subtle -- if
  -- 9001's career suddenly shows 99 kills, this is why.
  ('LOCAL-0004-DEV1', 1, 'dod_kalt',        1, 2, NOW() - INTERVAL 5 DAY,                      NOW() - INTERVAL 5 DAY + INTERVAL 20 MINUTE),
  -- match_type NULL is what EVERY production row looks like today: the
  -- HLStatsX daemon never populates the column. Unknown is not safe, so this
  -- must be excluded too.
  ('LOCAL-0005-DEV1', 1, 'dod_flash',       1, NULL, NOW() - INTERVAL 4 DAY,                   NOW() - INTERVAL 4 DAY + INTERVAL 20 MINUTE);

-- ------------------------------------------------------------ match stats
-- LOCAL-0001: two halves plus the half=0 TOTAL, which is their exact sum.
INSERT IGNORE INTO ktp_match_stats (match_id, player_id, half, kills, deaths, headshots, team_kills, suicides, damage, score) VALUES
  ('LOCAL-0001-DEV1',9001,1,21,14,4,0,0,2480,40), ('LOCAL-0001-DEV1',9001,2,19,16,3,1,0,2210,35),
  ('LOCAL-0001-DEV1',9001,0,40,30,7,1,0,4690,75),
  ('LOCAL-0001-DEV1',9002,1,18,17,2,0,1,2050,30), ('LOCAL-0001-DEV1',9002,2,17,15,3,0,0,1980,30),
  ('LOCAL-0001-DEV1',9002,0,35,32,5,0,1,4030,60),
  ('LOCAL-0001-DEV1',9003,1,15,19,1,0,0,1760,25), ('LOCAL-0001-DEV1',9003,2,14,18,2,0,0,1640,25),
  ('LOCAL-0001-DEV1',9003,0,29,37,3,0,0,3400,50),
  ('LOCAL-0001-DEV1',9004,1,12,20,1,1,0,1390,20), ('LOCAL-0001-DEV1',9004,2,13,21,0,0,1,1450,20),
  ('LOCAL-0001-DEV1',9004,0,25,41,1,1,1,2840,40),
  ('LOCAL-0001-DEV1',9005,1,11,18,2,0,0,1280,15), ('LOCAL-0001-DEV1',9005,2,10,17,1,0,0,1190,15),
  ('LOCAL-0001-DEV1',9005,0,21,35,3,0,0,2470,30),
  ('LOCAL-0001-DEV1',9006,1, 9,21,0,0,0,1020,10), ('LOCAL-0001-DEV1',9006,2, 8,19,1,0,0, 960,10),
  ('LOCAL-0001-DEV1',9006,0,17,40,1,0,0,1980,20);

-- LOCAL-0002: damage 0 throughout -- see the header note and KTPHLStatsX #33.
INSERT IGNORE INTO ktp_match_stats (match_id, player_id, half, kills, deaths, headshots, team_kills, suicides, damage, score) VALUES
  ('LOCAL-0002-DEV1',9007,1,24,12,6,0,0,0,45), ('LOCAL-0002-DEV1',9007,2,22,15,5,0,0,0,40),
  ('LOCAL-0002-DEV1',9007,0,46,27,11,0,0,0,85),
  ('LOCAL-0002-DEV1',9008,1,20,16,3,0,0,0,35), ('LOCAL-0002-DEV1',9008,2,18,17,2,1,0,0,30),
  ('LOCAL-0002-DEV1',9008,0,38,33,5,1,0,0,65),
  ('LOCAL-0002-DEV1',9009,1,16,18,2,0,1,0,25), ('LOCAL-0002-DEV1',9009,2,15,20,1,0,0,0,25),
  ('LOCAL-0002-DEV1',9009,0,31,38,3,0,1,0,50),
  ('LOCAL-0002-DEV1',9010,1,13,22,1,0,0,0,20), ('LOCAL-0002-DEV1',9010,2,14,19,2,0,0,0,20),
  ('LOCAL-0002-DEV1',9010,0,27,41,3,0,0,0,40);

-- LOCAL-0003: in progress -- half 1 only, no half=0 total row yet.
INSERT IGNORE INTO ktp_match_stats (match_id, player_id, half, kills, deaths, headshots, team_kills, suicides, damage, score) VALUES
  ('LOCAL-0003-DEV2',9011,1, 7, 4,2,0,0, 820,15),
  ('LOCAL-0003-DEV2',9012,1, 5, 6,1,0,0, 610,10),
  ('LOCAL-0003-DEV2',9001,1, 6, 5,1,0,0, 700,10);

-- LOCAL-0004 (12MAN) and LOCAL-0005 (match_type NULL): both EXCLUDED from every
-- endpoint. Player 9001 appears in both, so a leak shows up as inflated career
-- totals for a player who also has legitimate official stats -- the realistic
-- shape of the bug, rather than a player who would otherwise have none.
INSERT IGNORE INTO ktp_match_stats (match_id, player_id, half, kills, deaths, headshots, team_kills, suicides, damage, score) VALUES
  ('LOCAL-0004-DEV1',9001,1,99,1,50,0,0,9900,200), ('LOCAL-0004-DEV1',9001,0,99,1,50,0,0,9900,200),
  ('LOCAL-0004-DEV1',9002,1,88,2,40,0,0,8800,180), ('LOCAL-0004-DEV1',9002,0,88,2,40,0,0,8800,180),
  ('LOCAL-0005-DEV1',9001,1,77,3,30,0,0,7700,160), ('LOCAL-0005-DEV1',9001,0,77,3,30,0,0,7700,160);

-- -------------------------------------------------------- flag positions
-- dod_anzio's real geometry (map facts, not player data). NOTE flag_index 1 is
-- the Bridge, which sits between Street and the Axis side -- spawn order, not
-- geographic order. Key on flag_name.
INSERT IGNORE INTO ktp_flag_positions (server_id, map_name, flag_index, flag_name, origin_x, origin_y) VALUES
  (1,'dod_anzio',0,'POINT_ANZIO_LAUNDRY',-1495, -326),
  (1,'dod_anzio',1,'POINT_BRIDGE',        1040, -288),
  (1,'dod_anzio',2,'POINT_ANZIO_STREET',   448,  800),
  (1,'dod_anzio',3,'POINT_ANZIO_PLAZA',   -698,  923),
  (1,'dod_anzio',4,'POINT_ANZIO_HILL',    1375, 1682),
  (1,'dod_donner',0,'POINT_DONNER_ALLIEDHQ',   -1800, -900),
  (1,'dod_donner',1,'POINT_ALLIEDSTREET',       -700, -300),
  (1,'dod_donner',2,'POINT_DONNER_MAINSTREET',     0,    0),
  (1,'dod_donner',3,'POINT_AXISSTREET',          700,  300),
  (1,'dod_donner',4,'POINT_DONNER_AXISHQ',      1800,  900);
