/**
 * WavePill render tests
 *
 * The panel is the only on-air surface for the reinforcement-wave clock, and its
 * failure modes are all "shows a number that isn't true":
 *   - renders MM:SS across four windows, matching the game's own
 *     `hud_reinforcements` readout
 *   - counts down by RECOMPUTING from the anchor, never by decrementing (OBS
 *     throttles background-tab intervals to ~1 Hz and a decrementing counter
 *     would drift behind and never recover)
 *   - hides entirely once the anchor has run past zero with no refresh — a dead
 *     feed must not leave 00:00 on screen forever
 *   - hides during freeze / round end, when no respawns happen
 *   - hides when the side's clock is idle (seconds == null)
 */

import React from 'react';
import { render, act } from '@testing-library/react';
import WavePill from './WavePill';

const props = (over = {}) => ({
    seconds: 6,
    secondsAt: Date.now(),
    side: 'allies',
    frozen: false,
    ...over,
});

// The panel renders MM:SS across four recessed windows, so read the digits back
// as a joined string rather than matching free text.
function renderPill(over) {
    const utils = render(<WavePill {...props(over)} />);
    const panel = () => utils.container.querySelector('.wave-panel');
    const clock = () => {
        const d = [...utils.container.querySelectorAll('.wave-digit')].map(n => n.textContent);
        return d.length === 4 ? `${d[0]}${d[1]}:${d[2]}${d[3]}` : null;
    };
    return { ...utils, pill: panel, clock };
}

describe('WavePill', () => {

    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => { jest.useRealTimers(); });

    it('renders the countdown as MM:SS in four windows', () => {
        const { pill, clock } = renderPill();
        expect(pill()).not.toBeNull();
        expect(clock()).toBe('00:06');
    });

    it('carries the in-game stencil label', () => {
        const { container } = renderPill();
        expect(container.querySelector('.wave-label').textContent).toBe('REINFORCEMENTS');
    });

    it('rolls minutes over correctly', () => {
        const { clock } = renderPill({ seconds: 75 });
        expect(clock()).toBe('01:15');
    });

    it('renders nothing when the clock is idle', () => {
        const { pill } = renderPill({ seconds: null, secondsAt: null });
        expect(pill()).toBeNull();
    });

    it('renders nothing while frozen', () => {
        const { pill } = renderPill({ frozen: true });
        expect(pill()).toBeNull();
    });

    it('recomputes from the anchor rather than decrementing per tick', () => {
        const t0 = Date.now();
        const { clock } = renderPill({ seconds: 6, secondsAt: t0 });

        // The throttled-tab case: the clock jumps 3.8s with no interval callbacks,
        // then a single tick fires. A decrementing counter would land on 5s (one
        // tick, one decrement); recomputing from the anchor lands on the truth.
        act(() => {
            jest.setSystemTime(t0 + 3800);
            jest.advanceTimersByTime(200);
        });
        expect(clock()).toBe('00:02');
    });

    it('goes hot inside the last 3 seconds', () => {
        const { pill } = renderPill({ seconds: 6 });
        expect(pill().className).not.toContain('hot');

        act(() => { jest.advanceTimersByTime(3500); });   // 2.5s left
        expect(pill().className).toContain('hot');
    });

    it('holds 0s briefly at the wave, then hides when the feed stops refreshing', () => {
        const { pill, clock } = renderPill({ seconds: 2 });

        // Wave lands. A live plugin re-anchors ~250ms later; here nothing arrives.
        act(() => { jest.advanceTimersByTime(2500); });
        expect(clock()).toBe('00:00');

        // Past the staleness grace with still no refresh — the feed is gone.
        act(() => { jest.advanceTimersByTime(3000); });
        expect(pill()).toBeNull();
    });

    it('re-anchors on a new value instead of continuing the old countdown', () => {
        const { rerender, container } = render(<WavePill {...props({ seconds: 6 })} />);
        const clock = () => [...container.querySelectorAll('.wave-digit')].map(n => n.textContent).join('');

        act(() => { jest.advanceTimersByTime(5000); });
        expect(clock()).toBe('0001');

        // Wave fired, next period begins.
        act(() => {
            rerender(<WavePill {...props({ seconds: 10, secondsAt: Date.now() })} />);
        });
        expect(clock()).toBe('0010');
    });
});
