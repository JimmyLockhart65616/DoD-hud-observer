import FlagSwing from './flagswing';

/*
 * Adapts /caster's live store shape (string team/owner labels: 'allies' |
 * 'axis' | 'neutral') onto FlagSwing's numeric convention (1 | 2 | 0) and
 * returns the current p_allies. A wrong mapping here is exactly the class of
 * bug flagswing's own README warns about — team-string vs team-number is not
 * one of its pinned conventions, because the pipeline never has to make this
 * translation. It is ours alone, so it is tested here instead.
 *
 * Rebuilt from the CURRENT snapshot on every call rather than replayed
 * event-by-event: /caster's store already resolves roster/flag state
 * correctly (half boundaries, disconnects, the pinned conventions above), so
 * re-deriving from it each render is simpler and cannot drift from what the
 * rest of the page already shows.
 */
const TEAM_NUM = { allies: 1, axis: 2 };

export function pAlliesFromSnapshot({ alliesPlayers, axisPlayers, flags }) {
    const swing = new FlagSwing();
    [...alliesPlayers, ...axisPlayers].forEach(p => {
        const num = TEAM_NUM[p.team];
        if (!num) return;
        swing.setTeam(p.user_id, num);
        swing.setAlive(p.user_id, !p.dead);
    });
    flags.forEach(f => {
        const num = TEAM_NUM[f.owner];
        if (num) swing.setFlagOwner(f.flag_id, num);
    });
    return swing.pAllies();
}

// A swing worth a cue vs. ordinary drift. flagswing's own measured accuracy
// (median MAD 0.014 against real S10 reports, research/broadcast-director/
// equiv-s10-20260919) puts the metric's noise floor well under this — first
// pass, not yet calibrated against live air time; see broadcast-director.
export const MOMENTUM_THRESHOLD = 0.12;
// How far back "just now" looks for the comparison point.
export const MOMENTUM_WINDOW_MS = 15000;
// Minimum gap between two swing cues so one long slide fires once, not on
// every tick while it's still moving.
export const MOMENTUM_COOLDOWN_MS = 20000;

/**
 * `history`: [{t, v}], oldest first, already trimmed to MOMENTUM_WINDOW_MS.
 * Compares the newest reading to the OLDEST one still in that window — not
 * the single previous tick, which would fire on ordinary noise long before
 * a real swing finished.
 */
export function detectSwing(history) {
    if (history.length < 2) return null;
    const latest = history[history.length - 1];
    const oldest = history[0];
    const delta = latest.v - oldest.v;
    if (Math.abs(delta) < MOMENTUM_THRESHOLD) return null;
    return { team: delta > 0 ? 'allies' : 'axis', delta: Math.abs(delta), at: latest.t };
}
