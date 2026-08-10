import React, { useEffect, useRef, useState } from 'react';

import { useTeamName, setTeamName, swapTeamNames, isPinned, MAX_LEN } from './teamNames';

// The team label in the top bar, renameable in place.
//
// DOUBLE-click, never single: this renders on air, and an accidental click must
// not drop an input box into the broadcast. (OBS only forwards mouse events to a
// browser source while it is in Interact mode, so the caster opens Interact,
// double-clicks, types the name once, and closes it again.)
//
// Enter or clicking away commits; Escape reverts; an empty value restores the
// default side label. ⇄ swaps the two names — teams change sides at halftime,
// and retyping both is exactly the friction this is meant to remove.
const EditableTeamName = ({ side }) => {
    const name = useTeamName(side);
    const [draft, setDraft] = useState(null);   // null = not editing
    const inputRef = useRef(null);

    const pinned = isPinned(side);
    const editing = draft !== null;

    useEffect(() => {
        if (editing && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [editing]);

    if (pinned || !editing) {
        return (
            <span
                className="team-name-text"
                title={pinned ? undefined : 'Double-click to rename this team'}
                onDoubleClick={pinned ? undefined : () => setDraft(name)}
            >
                {name}
            </span>
        );
    }

    const commit = () => {
        setTeamName(side, draft);
        setDraft(null);
    };

    return (
        <span className="team-name-edit">
            <input
                ref={inputRef}
                className="team-name-input"
                value={draft}
                size={Math.max(draft.length, 6)}
                maxLength={MAX_LEN}
                onChange={e => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={e => {
                    if (e.key === 'Enter') commit();
                    else if (e.key === 'Escape') setDraft(null);
                }}
            />
            <button
                type="button"
                className="team-name-swap"
                title="Swap the two team names (use at halftime)"
                // Keep focus on the input: blurring would commit and unmount this
                // button before its click ever lands.
                onMouseDown={e => e.preventDefault()}
                onClick={() => {
                    setTeamName(side, draft);
                    swapTeamNames();
                    setDraft(null);
                }}
            >
                ⇄
            </button>
        </span>
    );
};

export default EditableTeamName;
