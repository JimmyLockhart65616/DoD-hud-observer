import { useEffect, useState } from 'react';

// Broadcast team names for the two sides.
//
// "Stateless" in the sense the casters asked for: there is no backend field, no
// match metadata, no roster lookup. A name is typed once on the machine running
// the overlay and lives in that browser's localStorage until it is typed over,
// so nothing has to be provisioned per match and nothing can go stale server-side.
//
// Precedence, highest first:
//   1. ?allies=/?axis= on the page URL — pinned, and the in-place editor turns
//      itself off for a pinned side (an edit that silently loses to the URL on
//      the next reload is worse than no edit control).
//   2. localStorage — what the in-place editor writes.
//   3. the side's default label.

export const DEFAULT_NAMES = { allies: 'ALLIES', axis: 'AXIS' };
export const MAX_LEN = 24;

const STORAGE_KEY = 'hud.team_names';

// One line of an on-air label: no newlines, no runs of whitespace, bounded
// length so a paste can't shove the score out of the top bar.
const clean = (value) => String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LEN);

// Storage and URL access are wrapped: OBS's embedded Chromium and private
// windows can both throw on localStorage, and the overlay must still render.
function readStored() {
    try {
        const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
        if (!parsed || typeof parsed !== 'object') return {};
        const out = {};
        ['allies', 'axis'].forEach((side) => {
            const name = clean(parsed[side]);
            if (name) out[side] = name;
        });
        return out;
    } catch (e) {
        return {};
    }
}

function writeStored(next) {
    try {
        if (Object.keys(next).length === 0) window.localStorage.removeItem(STORAGE_KEY);
        else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (e) {
        /* non-persistent session — the in-memory notify below still updates the page */
    }
}

function readPinned() {
    try {
        const params = new URLSearchParams(window.location.search);
        const out = {};
        ['allies', 'axis'].forEach((side) => {
            const name = clean(params.get(side));
            if (name) out[side] = name;
        });
        return out;
    } catch (e) {
        return {};
    }
}

export const isPinned = (side) => Object.prototype.hasOwnProperty.call(readPinned(), side);

export function teamName(side) {
    return readPinned()[side] || readStored()[side] || DEFAULT_NAMES[side] || '';
}

const listeners = new Set();

function notify() {
    listeners.forEach((fn) => fn());
}

export function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

// An empty value clears the override rather than storing a blank label, so
// selecting-all and hitting Enter is the "put it back to ALLIES" gesture.
export function setTeamName(side, value) {
    const name = clean(value);
    const next = readStored();
    if (name && name !== DEFAULT_NAMES[side]) next[side] = name;
    else delete next[side];
    writeStored(next);
    notify();
}

// Teams swap sides at halftime, so the names have to follow. Swaps the STORED
// pair, not the resolved one — a side left at its default stays at its default
// instead of having the literal string "AXIS" written onto it.
export function swapTeamNames() {
    const stored = readStored();
    writeStored({
        ...(stored.axis ? { allies: stored.axis } : {}),
        ...(stored.allies ? { axis: stored.allies } : {}),
    });
    notify();
}

// Cross-tab sync is free and occasionally useful (a caster with /screen and
// /caster open in the same browser); it is not the primary path.
if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('storage', (e) => {
        if (!e || e.key === null || e.key === STORAGE_KEY) notify();
    });
}

export function useTeamName(side) {
    const [name, setName] = useState(() => teamName(side));
    useEffect(() => {
        setName(teamName(side));
        return subscribe(() => setName(teamName(side)));
    }, [side]);
    return name;
}
