import React from 'react';
import Timer from './timer/Timer';

const Score = ({ logoLeft, logoRight, roundState, alliesScore, axisScore, timeleft, timeleftAt }) => {
    const showLeftLogo  = logoLeft  && logoLeft  !== 'default.png';
    const showRightLogo = logoRight && logoRight !== 'default.png';

    return (
        <div className="score">
            {showLeftLogo && (
                <div className="logo-area">
                    <img src={`assets/teams/${logoLeft}`} alt="" />
                </div>
            )}

            <div className="team-score allies-score">{alliesScore}</div>

            <div className="timer-area">
                <Timer
                    timeleft={timeleft}
                    timeleftAt={timeleftAt}
                    frozen={roundState.round_freeze || roundState.round_end}
                />
            </div>

            <div className="team-score axis-score">{axisScore}</div>

            {showRightLogo && (
                <div className="logo-area">
                    <img src={`assets/teams/${logoRight}`} alt="" />
                </div>
            )}
        </div>
    );
}

export default Score;
