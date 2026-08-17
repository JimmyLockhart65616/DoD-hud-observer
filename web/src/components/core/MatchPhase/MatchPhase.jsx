import React from 'react';

/**
 * The broadcast phase caption — what part of the match a viewer is watching.
 *
 * Deliberately its own vocabulary, NOT /hq's `HALF 1` or /caster's `H1`. Those
 * are operator glanceables read across a room or off a second monitor; this one
 * is read by viewers on a stream who have no idea what H2 means.
 *
 * The phase comes from the plugin (KTPHudObserver compute_phase) and is never
 * inferred here — see the store slice for why `half` cannot stand in for it.
 */

/** half is 1, 2, or 101+ for overtime periods. */
const halfLabel = (half) => {
    if (half >= 101) return `OVERTIME ${half - 100}`;
    if (half === 2) return '2ND HALF';
    return '1ST HALF';
};

/** mode is KTPMatchHandler's _ktp_mode: "" | "h2" | "otN". */
const otNext = (mode) =>
    (typeof mode === 'string' && mode.slice(0, 2) === 'ot' ? `OVERTIME ${mode.slice(2)}` : null);

/**
 * Phases in which the half clock is genuinely NOT advancing, so the countdown
 * must be frozen rather than left free-running client-side.
 *
 * Deliberately the BREAK phases only, not "everything that isn't live":
 *   - `idle` is pub play, where the map clock really is counting down;
 *   - `pregame` is ready-up, same;
 *   - `golive` is a ~10s countdown where the value is already the projected
 *     post-restart time, and freezing it would be a distinction nobody sees.
 * Freezing those would put a dead clock on a server where the game is running.
 *
 * Mirrored by CLOCK_STOPPED_PHASES in backend/src/handler/hqBoard.ts — the HQ
 * board and the overlay must not disagree about whether the clock is moving.
 */
const CLOCK_STOPPED = new Set(['halftime', 'ot_break', 'postmatch']);

export const isClockStopped = (phase) => CLOCK_STOPPED.has(phase);

/**
 * Rendered as a <div>, not a <span>: e2e/hud-timeline.spec.ts waits on
 * `.timer-area span` to mean "the clock is up", and a sibling span in that
 * container would satisfy it before the clock exists.
 */
const MatchPhase = ({ phase, mode, half }) => {
    let text = null;
    let tone = 'live';

    switch (phase) {
        case 'pregame':   text = 'WARM-UP';                            tone = 'wait'; break;
        case 'golive':    text = 'GOING LIVE';                         tone = 'go';   break;
        case 'live':      text = halfLabel(half);                      tone = 'live'; break;
        case 'halftime':  text = 'HALFTIME';                           tone = 'wait'; break;
        case 'ot_break':  text = `${otNext(mode) ?? 'OVERTIME'} NEXT`; tone = 'wait'; break;
        case 'postmatch': text = 'FINAL';                              tone = 'go';   break;
        default:
            // `idle` (pub play or an empty box), null (older plugin / fresh tab
            // before the snapshot lands), or a phase from a newer plugin this
            // build doesn't know. Say nothing rather than claim a match state.
            return null;
    }

    return <div className={`match-phase match-phase-${tone}`}>{text}</div>;
};

export default MatchPhase;
