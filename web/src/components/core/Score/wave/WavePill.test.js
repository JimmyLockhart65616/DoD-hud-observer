/**
 * WavePill render tests
 *
 * The pill is the only on-air surface for the reinforcement-wave clock, and its
 * failure modes are all "shows a number that isn't true":
 *   - counts down by RECOMPUTING from the anchor, never by decrementing (OBS
 *     throttles background-tab intervals to ~1 Hz and a decrementing counter
 *     would drift behind and never recover)
 *   - hides entirely once the anchor has run past zero with no refresh — a dead
 *     feed must not leave "0s" on screen forever
 *   - hides during freeze / round end, when no respawns happen
 *   - hides when the side's clock is idle (seconds == null)
 */

import React from 'react';
import { render, act } from '@testing-library/react';
import WavePill from './WavePill';

const props = (over = {}) => ({
    seconds: 6,
    secondsAt: Date.now(),
    pending: 3,
    side: 'allies',
    frozen: false,
    ...over,
});

function renderPill(over) {
    const utils = render(<WavePill {...props(over)} />);
    return { ...utils, pill: () => utils.container.querySelector('.wave-pill') };
}

describe('WavePill', () => {

    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => { jest.useRealTimers(); });

    it('renders seconds and the incoming count', () => {
        const { pill } = renderPill();
        expect(pill()).not.toBeNull();
        expect(pill().textContent).toContain('6s');
        expect(pill().textContent).toContain('+3');
    });

    it('renders nothing when the clock is idle', () => {
        const { pill } = renderPill({ seconds: null, secondsAt: null });
        expect(pill()).toBeNull();
    });

    it('renders nothing while frozen', () => {
        const { pill } = renderPill({ frozen: true });
        expect(pill()).toBeNull();
    });

    it('omits the +N when nobody is pending', () => {
        const { pill } = renderPill({ pending: 0 });
        expect(pill().textContent).toContain('6s');
        expect(pill().textContent).not.toContain('+');
    });

    it('recomputes from the anchor rather than decrementing per tick', () => {
        const t0 = Date.now();
        const { pill } = renderPill({ seconds: 6, secondsAt: t0 });

        // The throttled-tab case: the clock jumps 3.8s with no interval callbacks,
        // then a single tick fires. A decrementing counter would land on 5s (one
        // tick, one decrement); recomputing from the anchor lands on the truth.
        act(() => {
            jest.setSystemTime(t0 + 3800);
            jest.advanceTimersByTime(200);
        });
        expect(pill().textContent).toContain('2s');
    });

    it('goes hot inside the last 3 seconds', () => {
        const { pill } = renderPill({ seconds: 6 });
        expect(pill().className).not.toContain('hot');

        act(() => { jest.advanceTimersByTime(3500); });   // 2.5s left
        expect(pill().className).toContain('hot');
    });

    it('holds 0s briefly at the wave, then hides when the feed stops refreshing', () => {
        const { pill } = renderPill({ seconds: 2 });

        // Wave lands. A live plugin re-anchors ~250ms later; here nothing arrives.
        act(() => { jest.advanceTimersByTime(2500); });
        expect(pill().textContent).toContain('0s');

        // Past the staleness grace with still no refresh — the feed is gone.
        act(() => { jest.advanceTimersByTime(3000); });
        expect(pill()).toBeNull();
    });

    it('re-anchors on a new value instead of continuing the old countdown', () => {
        const { rerender, container } = render(<WavePill {...props({ seconds: 6 })} />);
        const pill = () => container.querySelector('.wave-pill');

        act(() => { jest.advanceTimersByTime(5000); });
        expect(pill().textContent).toContain('1s');

        // Wave fired, next period begins.
        act(() => {
            rerender(<WavePill {...props({ seconds: 10, secondsAt: Date.now(), pending: 1 })} />);
        });
        expect(pill().textContent).toContain('10s');
        expect(pill().textContent).toContain('+1');
    });
});
