import React from 'react';
import Timer from './timer/Timer';
import TickClock from './tick/TickClock';
import TickAward from './tick/TickAward';

const Score = ({
    logoLeft, logoRight, roundState, alliesScore, axisScore, timeleft, timeleftAt,
    scoringIn, scoringAt, scoringAllies, scoringAxis,
}) => {
    const showLeftLogo  = logoLeft  && logoLeft  !== 'default.png';
    const showRightLogo = logoRight && logoRight !== 'default.png';
    const frozen = roundState.round_freeze || roundState.round_end;

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
