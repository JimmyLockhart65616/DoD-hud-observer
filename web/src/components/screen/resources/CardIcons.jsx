// Inline SVG glyphs for the player cards (kills/deaths/objective/grenades).
//
// Deliberately dependency-free: react-icons is NOT installed in web/ (its only
// import lives in a route excluded from the /screen overlay), so we ship the
// handful of paths we actually draw instead of pulling in a package.
//
// Every icon uses fill="currentColor" so color is driven by CSS `color` on the
// wrapping stat element (e.g. .card-kills { color: ... }). Sizing is via CSS
// (.card-stat svg { width/height }).

import React from 'react';

const svgProps = { viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true, focusable: false };

// Kills — crosshair/target: ring + center dot + 4 ticks.
export const IconTarget = (props) => (
    <svg {...svgProps} {...props}>
        <path fillRule="evenodd" d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 3a7 7 0 110 14 7 7 0 010-14z" />
        <circle cx="12" cy="12" r="2.4" />
        <rect x="11" y="0" width="2" height="5" />
        <rect x="11" y="19" width="2" height="5" />
        <rect x="0" y="11" width="5" height="2" />
        <rect x="19" y="11" width="5" height="2" />
    </svg>
);

// Deaths — skull with hollow eyes (evenodd cuts the eye holes).
export const IconSkull = (props) => (
    <svg {...svgProps} fillRule="evenodd" {...props}>
        <path d="M12 2C6.9 2 3 5.7 3 10.4c0 2.8 1.4 4.9 3.4 6.2V19a2 2 0 002 2h.6v-2h1.5v2h2v-2h1.5v2h.6a2 2 0 002-2v-2.4c2-1.3 3.4-3.4 3.4-6.2C21 5.7 17.1 2 12 2zM9 12.3a2 2 0 110-4 2 2 0 010 4zm6 0a2 2 0 110-4 2 2 0 010 4z" />
    </svg>
);

// Objective score (flag caps) — flag on a pole.
export const IconFlag = (props) => (
    <svg {...svgProps} {...props}>
        <path d="M5 2a1 1 0 011 1v18a1 1 0 11-2 0V3a1 1 0 011-1z" />
        <path d="M7 3h11.5a1 1 0 01.82 1.57L17 8l2.32 3.43A1 1 0 0118.5 13H7z" />
    </svg>
);

// Grenades — body + top cap, lever and pin ring.
export const IconGrenade = (props) => (
    <svg {...svgProps} {...props}>
        <circle cx="11" cy="14.5" r="6" />
        <rect x="8.5" y="5.5" width="5" height="3" rx="0.6" />
        <path d="M13.5 6h3.6l1.6 2.1-1.9.9-1.1-1.4h-2.2z" />
        <rect x="9.3" y="3.6" width="3.4" height="2" rx="1" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
);

export default { IconTarget, IconSkull, IconFlag, IconGrenade };
