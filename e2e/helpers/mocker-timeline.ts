/**
 * Named timestamp constants from the mocker's event sequence (backend/src/mocker/data.ts).
 * Times are milliseconds from mocker start (which triggers on first Socket.IO connection).
 */

export const HALF_START = 50;
export const PLAYERS_CONNECTED = 650;       // last player_connect (ian)
export const FREEZE_TIME = 1000;
export const FLAGS_INIT = 1100;
export const PLAYERS_SPAWNED = 1200;        // all 12 players spawn
export const ROUND_START = 4000;
export const CASTER_OBSERVE = 4500;         // observing Raphinha (STEAM_0:0:1001)
export const PRONE_START = 6000;            // ian goes prone
export const FLAG_CAP_AXIS = 8000;          // Axis starts capping Church
export const FIRST_KILL = 9000;             // mogers kills ORTIN with k98
export const SECOND_KILL = 10000;           // Raphinha kills omenator with garand
export const FLAG_CAP_STOPPED = 10500;      // Axis cap interrupted
export const ALLIES_CAP_START = 13000;      // Allies start capping Church
export const PRONE_KILL = 14000;            // storm kills ian while prone
export const FLAG_CAPTURED = 15000;         // Allies capture Church (score 1-0)
export const SCORES_UPDATED = 15100;        // player_score events
export const TICK_REBROADCAST = 17000;      // TeamScore re-emit, no value change
export const TEAMKILL = 21000;              // Polak TKs bad
export const TICK_BUMP = 25500;             // tick scoring bumps allies to 2 (held flag)
export const ROUND_END = 30000;             // Allies win round 1 — cumulative 2-0
export const ROUND2_FREEZE = 35000;
export const ROUND2_SPAWNED = 35500;
export const ROUND2_START = 38000;
export const HALF1_END = 55000;              // round_end of round 2, allies/axis 1-1
export const HALF2_START = 62000;            // half_start with half=2
export const HALF2_TEAM_SCORE = 62050;       // post–half_start team_score 1-1 (carryover)
export const HALF2_ROUND_START = 66000;
export const TIMELINE_END = 75000;

// Player names for assertions
export const ALLIES_NAMES = ['Raphinha', 'bud', 'ORTIN', 'storm', 'MaT*', 'BitchX'];
export const AXIS_NAMES = ['mogers', 'omenator', 'E t', 'bad', 'Polak', 'ian'];
