import React from 'react';

// Points this side will receive on the next territorial scoring tick, rendered
// directly beneath the score digit it is about to change.
//
// `value` is null whenever the plugin could not corroborate its award model —
// an unvalidated map, a dodx too old to report control-point default owners, or
// an operator pulling `dod_hud_score_award` mid-broadcast. Render nothing then;
// the countdown beside it stays up, because the timing is an observation while
// the amount is a model.
//
// A `+0` is REAL INFORMATION, not an absence: it says this side banks nothing
// on the next tick, which is precisely the thing a caster wants to know when a
// team is sitting on its own flags. Guard on null, never on falsiness.

const TickAward = ({ value, side }) => {
    if (value == null) return null;

    return (
        <span className={`tick-award tick-award-${side}`} title="Points on the next scoring tick">
            +{value}
        </span>
    );
};

export default TickAward;
