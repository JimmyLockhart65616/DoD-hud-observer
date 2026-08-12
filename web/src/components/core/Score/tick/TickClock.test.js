/**
 * TickClock render tests
 *
 * The countdown to DoD's next territorial scoring award. Its failure modes are
 * all "shows a moment that isn't true":
 *   - counts down by RECOMPUTING from the anchor, never by decrementing (OBS
 *     throttles background-tab intervals to ~1 Hz and a decrementing counter
 *     would drift behind and never recover)
 *   - hides entirely once the anchor has run past zero with no refresh — a dead
 *     feed must not leave 0:00 on screen forever
 *   - hides during freeze / round end, when the master is not awarding
 *   - hides when the plugin has no honest answer (seconds == null)
 *   - re-anchors on a fresh value rather than continuing the old countdown
 */

import React from 'react';
import { render, act } from '@testing-library/react';
import TickClock from './TickClock';

const props = (over = {}) => ({
    seconds: 6,
    secondsAt: Date.now(),
    frozen: false,
    ...over,
});

function renderClock(over) {
    const { container, rerender } = render(<TickClock {...props(over)} />);
    return {
        container,
        // Read the digits specifically — .tick-clock also carries the label, so
        // its textContent would be "NEXT SCORE0:06".
        text: () => container.querySelector('.tick-clock-value')?.textContent ?? null,
        label: () => container.querySelector('.tick-clock-label')?.textContent ?? null,
        hot: () => !!container.querySelector('.tick-clock.hot'),
        rerender: (next) => rerender(<TickClock {...props(next)} />),
    };
}

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
});

describe('TickClock', () => {

    it('renders the remaining seconds as M:SS', () => {
        const c = renderClock({ seconds: 6 });
        expect(c.text()).toBe('0:06');
    });

    it('labels itself, since the countdown is meaningless unlabelled', () => {
        // The game never shows this clock, so a bare number next to the half
        // timer reads as a second match clock.
        const c = renderClock({ seconds: 6 });
        expect(c.label()).toBe('NEXT SCORE');
    });

    it('pads and formats past a minute', () => {
        const c = renderClock({ seconds: 75 });
        expect(c.text()).toBe('1:15');
    });

    it('renders nothing when the plugin gave no answer', () => {
        const c = renderClock({ seconds: null, secondsAt: null });
        expect(c.text()).toBeNull();
    });

    it('renders nothing while frozen', () => {
        const c = renderClock({ seconds: 6, frozen: true });
        expect(c.text()).toBeNull();
    });

    it('recomputes from the anchor rather than decrementing', () => {
        // Jump the wall clock 3.8s with NO interval callbacks in between — the
        // state an OBS background tab is routinely in. A decrementing
        // implementation fires once and lands on 0:05; recomputing lands on 0:02.
        const t0 = Date.now();
        const c = renderClock({ seconds: 6, secondsAt: t0 });
        expect(c.text()).toBe('0:06');

        act(() => {
            jest.setSystemTime(t0 + 3800);
            jest.advanceTimersByTime(200);
        });

        expect(c.text()).toBe('0:02');
    });

    it('goes hot inside the last 3 seconds', () => {
        const t0 = Date.now();
        const c = renderClock({ seconds: 6, secondsAt: t0 });
        expect(c.hot()).toBe(false);

        act(() => {
            jest.setSystemTime(t0 + 4000);
            jest.advanceTimersByTime(200);
        });

        expect(c.text()).toBe('0:02');
        expect(c.hot()).toBe(true);
    });

    it('holds 0:00 briefly past zero, then hides', () => {
        const t0 = Date.now();
        const c = renderClock({ seconds: 2, secondsAt: t0 });

        act(() => {
            jest.setSystemTime(t0 + 3000);
            jest.advanceTimersByTime(200);
        });
        expect(c.text()).toBe('0:00');

        // Past the stale threshold the feed is presumed dead. A countdown parked
        // on 0:00 reads as an award that never lands.
        act(() => {
            jest.setSystemTime(t0 + 8000);
            jest.advanceTimersByTime(200);
        });
        expect(c.text()).toBeNull();
    });

    it('re-anchors on a fresh value instead of continuing', () => {
        const t0 = Date.now();
        const c = renderClock({ seconds: 2, secondsAt: t0 });

        act(() => {
            jest.setSystemTime(t0 + 2000);
            jest.advanceTimersByTime(200);
        });
        expect(c.text()).toBe('0:00');

        // The tick landed and the next cycle begins.
        act(() => {
            c.rerender({ seconds: 30.5, secondsAt: Date.now() });
        });
        expect(c.text()).toBe('0:31');
    });
});
