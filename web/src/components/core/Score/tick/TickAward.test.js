/**
 * TickAward render tests
 *
 * The projected points a side receives on the next territorial scoring tick.
 * The distinction this component exists to protect: `+0` (a side holding only
 * its own home flags banks nothing — real, castable information) versus `null`
 * (the plugin could not corroborate its award model and is deliberately silent).
 * Collapsing the two is the bug, and a plain falsy check does exactly that.
 */

import React from 'react';
import { render } from '@testing-library/react';
import TickAward from './TickAward';

function renderAward(over = {}) {
    const { container } = render(<TickAward value={4} side="allies" {...over} />);
    const el = container.querySelector('.tick-award');
    return { el, text: () => el?.textContent ?? null };
}

describe('TickAward', () => {

    it('renders the projected points with a sign', () => {
        expect(renderAward({ value: 4 }).text()).toBe('+4');
    });

    it('renders +0 rather than nothing', () => {
        expect(renderAward({ value: 0 }).text()).toBe('+0');
    });

    it('renders nothing when the award is unknown', () => {
        expect(renderAward({ value: null }).el).toBeNull();
    });

    it('renders nothing when the award is undefined', () => {
        expect(renderAward({ value: undefined }).el).toBeNull();
    });

    it('carries the side class', () => {
        expect(renderAward({ value: 2, side: 'axis' }).el.className)
            .toContain('tick-award-axis');
        expect(renderAward({ value: 2, side: 'allies' }).el.className)
            .toContain('tick-award-allies');
    });
});
