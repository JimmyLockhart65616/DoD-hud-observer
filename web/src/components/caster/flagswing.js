/**
 * VENDORED, do not hand-edit. Copied verbatim from
 * KTPInfrastructure/scripts/flagswing/flagswing.js @ 08c76070 (2026-09-08),
 * flag_swing_v1, definition_version 1. That repo is the source of truth and
 * owns the golden-file test suite (`node --test` there, not here) — if
 * flag_swing.py's coefficients or conventions change, re-copy this file
 * rather than patching it locally, per that repo's own README.
 *
 * flag_swing_v1 baseline: P(allies win the half) from flag control + man advantage.
 *
 * Reference port of `_HalfState.p_allies` in
 * scripts/flag_swing.py (KTP analytics pipeline, definition_version 1).
 * Dependency-free ES module; runs in Node and in the browser.
 *
 *   p_allies = sigmoid(a * (alliedFlags - axisFlags) / flagCount
 *                    + b * (alliesAlive - axisAlive) / rosterSize)
 *
 * Conventions (all load-bearing, see README):
 *   team 1 = Allies, team 2 = Axis, anything else = neutral / ignored.
 *   flagCount  = DISTINCT flag indices seen in the match, 5 if none, floor 1.
 *   rosterSize = players on BOTH teams combined, floor 1.
 */

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

export class FlagSwing {
  constructor({ flagCoefficient = 2.0, aliveCoefficient = 1.0, flagCount, rosterSize } = {}) {
    if (flagCoefficient < 0 || aliveCoefficient < 0) {
      throw new RangeError('flag-swing coefficients must be >= 0');
    }
    this.flagCoefficient = flagCoefficient;
    this.aliveCoefficient = aliveCoefficient;
    this.flagCount = flagCount;
    this.rosterSize = rosterSize;
    this.owners = new Map(); // flagIndex -> 1 | 2 | 0 (neutral)
    this.alive = new Map(); // playerId -> boolean
    this.teams = new Map(); // playerId -> 1 | 2
  }

  /** Denominator of the flag term: `max(len(flag_ids) or 5, 1)` in Python. */
  get flagDenominator() {
    return Math.max(this.flagCount || 5, 1);
  }

  /** Denominator of the alive term: `max(len(teams), 1)` in Python, both teams. */
  get rosterDenominator() {
    return Math.max(this.rosterSize ?? this.teams.size, 1);
  }

  /** Add/replace a roster entry. Team other than 1 or 2 drops the player. */
  setTeam(playerId, team) {
    if (team !== 1 && team !== 2) {
      this.teams.delete(playerId);
      this.alive.delete(playerId);
      return;
    }
    this.teams.set(playerId, team);
    if (!this.alive.has(playerId)) this.alive.set(playerId, true);
  }

  /** Flag ownership change. Owner other than 1 or 2 is stored as neutral (0). */
  setFlagOwner(flagIndex, ownerTeam) {
    this.owners.set(flagIndex, ownerTeam === 1 || ownerTeam === 2 ? ownerTeam : 0);
  }

  /** Frag (false) or spawn (true). Ignored for players not on the roster. */
  setAlive(playerId, up) {
    if (this.alive.has(playerId)) this.alive.set(playerId, !!up);
  }

  /** Half boundary: everyone respawns, flag ownership is forgotten entirely. */
  resetHalf() {
    this.owners.clear();
    for (const pid of this.teams.keys()) this.alive.set(pid, true);
  }

  pAllies() {
    let flagDiff = 0;
    for (const owner of this.owners.values()) {
      if (owner === 1) flagDiff += 1;
      else if (owner === 2) flagDiff -= 1;
    }
    let aliveDiff = 0;
    for (const [pid, up] of this.alive) {
      if (!up) continue;
      const team = this.teams.get(pid);
      if (team === 1) aliveDiff += 1;
      else if (team === 2) aliveDiff -= 1;
    }
    return sigmoid(
      this.flagCoefficient * (flagDiff / this.flagDenominator) +
        this.aliveCoefficient * (aliveDiff / this.rosterDenominator),
    );
  }
}

export default FlagSwing;
