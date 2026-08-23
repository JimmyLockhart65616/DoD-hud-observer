-- Local-development schema for the KTPHLStatsX `hlstatsx` database.
--
-- WHY THIS EXISTS. Production's schema lives in the KTPHLStatsX repo as a base
-- file plus ~19 numbered migrations, and that fork is a LAYERED DELTA over
-- upstream HLStatsX:CE — it does not ship `sql/install.sql` or the six .pm
-- modules the daemon needs. Reproducing all of that just so a developer can see
-- `/api/stats/*` return something is not worth it, and would rot against a repo
-- we do not own.
--
-- So this is a deliberately MINIMAL subset: only the tables `backend/src/statsdb`
-- actually reads, with column types and collations copied from the live
-- production `SHOW CREATE TABLE` so the shapes, and the traps, are faithful.
--
-- ⚠️ THIS IS NOT THE PRODUCTION SCHEMA AND MUST NEVER BE APPLIED TO IT.
-- Production is owned by the HLStatsX Perl daemon and migrated only through
-- KTPHLStatsX's own numbered migrations. This file exists purely so the local
-- docker stack has something to answer with.
--
-- Two faithful details worth keeping, because they are load-bearing traps:
--
--   * `hlstats_*` tables are MyISAM and `utf8mb4_unicode_ci`, while the `ktp_*`
--     tables are InnoDB. Production's ktp_* tables are utf8mb4_0900_ai_ci, so
--     joining `match_id` across the two families there raises "Illegal mix of
--     collations". None of our queries cross that boundary; if one ever does it
--     needs an explicit COLLATE and this file should be made to disagree the
--     same way production does.
--   * `half` means two different things (match TOTAL in ktp_match_stats vs
--     "no match context" on event tables). The fixture exercises both.
--
-- Applied idempotently by data-server/start.sh on every boot.

CREATE TABLE IF NOT EXISTS `ktp_matches` (
  `id` int NOT NULL AUTO_INCREMENT,
  `match_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `server_id` int NOT NULL,
  `map_name` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `half` tinyint DEFAULT '1',
  `match_type` tinyint unsigned DEFAULT NULL
      COMMENT 'KTPMatchHandler enum: 0=official, 1=scrim, 2=12man, 3=draft, 4=KTP OT, 5=draft OT',
  `start_time` datetime NOT NULL,
  `end_time` datetime DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_match_id_half` (`match_id`,`half`),
  KEY `idx_start_time` (`start_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ktp_match_stats` (
  `id` int NOT NULL AUTO_INCREMENT,
  `match_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `player_id` int NOT NULL,
  `half` tinyint NOT NULL DEFAULT '0' COMMENT '0 = stored match TOTAL, 1/2 = halves, 3+ = OT',
  `kills` int DEFAULT '0',
  `deaths` int DEFAULT '0',
  `headshots` int DEFAULT '0',
  `team_kills` int DEFAULT '0',
  `suicides` int DEFAULT '0',
  `damage` int DEFAULT '0',
  `score` int DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_match_player_half` (`match_id`,`player_id`,`half`),
  KEY `idx_match` (`match_id`),
  KEY `idx_player` (`player_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ktp_flag_positions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `server_id` int NOT NULL,
  `map_name` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `flag_index` int NOT NULL COMMENT 'dodx spawn order — NOT the DLL cp_index; key on flag_name',
  `flag_name` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `origin_x` int NOT NULL,
  `origin_y` int NOT NULL COMMENT '2D only — dodx exposes no CP_origin_z',
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_server_map_flag` (`server_id`,`map_name`,`flag_index`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- MyISAM to match production. It is why the ktp_* tables carry no foreign keys
-- to these: MyISAM has no FK support.
CREATE TABLE IF NOT EXISTS `hlstats_Players` (
  `playerId` int unsigned NOT NULL AUTO_INCREMENT,
  `lastName` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  PRIMARY KEY (`playerId`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `hlstats_PlayerUniqueIds` (
  `playerId` int unsigned NOT NULL DEFAULT '0',
  `uniqueId` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT ''
      COMMENT 'SHORT form: 1:748805 — the HUD uses STEAM_0:1:748805',
  `game` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `merge` int unsigned DEFAULT NULL,
  PRIMARY KEY (`uniqueId`,`game`),
  KEY `playerId` (`playerId`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
