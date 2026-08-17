import React from 'react';
import Timer from './timer/Timer';
import TickClock from './tick/TickClock';
import TickAward from './tick/TickAward';
import MatchPhase, { isClockStopped } from '../MatchPhase/MatchPhase';

const Score = ({
    logoLeft, logoRight, roundState, alliesScore, axisScore, timeleft, timeleftAt,
    scoringIn, scoringAt, scoringAllies, scoringAxis,
    phase, phaseMode, half, showPhase,
}) => {
    const showLeftLogo  = logoLeft  && logoLeft  !== 'default.png';
    const showRightLogo = logoRight && logoRight !== 'default.png';
    // round_freeze/round_end are dead in extension mode (the plugin never emits
    // round_* events), so before the phase feed the clock free-ran through every
    // halftime and kept counting after the final whistle — a running clock over a
    // HALFTIME STATS board. The phase is the only signal that stops it.
    const frozen = roundState.round_freeze || roundState.round_end || isClockStopped(phase);

    return (
        <div className="score">
            {showLeftLogo && (
                <div className="logo-area">
                    <img src={`assets/teams/${logoLeft}`} alt="" />
                </div>
            )}

            {/* The projected tick award sits under the number it is about to
                change, rather than in a panel of its own — the top bar's centre
                is the only band with room, and tying each number to its score
                removes any question of which side it belongs to.

                .allies-score / .axis-score stay on the VALUE span, not on the
                wrapper: e2e asserts scores by that selector's textContent, and
                on the wrapper it would read "2+4". They mean "the score number",
                and must keep meaning that as decorations accumulate. */}
            <div className="team-score">
                <span className="team-score-value allies-score">{alliesScore}</span>
                <span className="tick-award-slot">
                    <TickAward value={scoringAllies} side="allies" />
                </span>
            </div>

            <div className="timer-area">
                {/* Above the clock, mirroring the tick slot below it: a fixed-height
                    slot so the bar's geometry never moves as the phase comes and
                    goes (the badge is empty during pub play). */}
                {showPhase && (
                    <span className="match-phase-slot">
                        <MatchPhase phase={phase} mode={phaseMode} half={half} />
                    </span>
                )}
                <Timer
                    timeleft={timeleft}
                    timeleftAt={timeleftAt}
                    frozen={frozen}
                />
                <span className="tick-clock-slot">
                    <TickClock
                        seconds={scoringIn}
                        secondsAt={scoringAt}
                        frozen={frozen}
                    />
                </span>
            </div>

            <div className="team-score">
                <span className="team-score-value axis-score">{axisScore}</span>
                <span className="tick-award-slot">
                    <TickAward value={scoringAxis} side="axis" />
                </span>
            </div>

            {showRightLogo && (
                <div className="logo-area">
                    <img src={`assets/teams/${logoRight}`} alt="" />
                </div>
            )}
        </div>
    );
}

export default Score;
