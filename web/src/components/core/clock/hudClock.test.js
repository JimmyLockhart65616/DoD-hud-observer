import {
    hudNow, setHudClockSource, hudAfter, nextHudTimerAt, runNextHudTimer, clearHudTimers,
} from './hudClock';

afterEach(() => {
    setHudClockSource(null);
    jest.useRealTimers();
});

describe('hudClock', () => {
    it('is the wall clock when no source is installed', () => {
        const before = Date.now();
        const t = hudNow();
        expect(t).toBeGreaterThanOrEqual(before);
        expect(t).toBeLessThanOrEqual(Date.now());
    });

    it('reads an installed source, and goes back to the wall clock when removed', () => {
        let v = 1000;
        setHudClockSource(() => v);
        expect(hudNow()).toBe(1000);
        v = 2500;
        expect(hudNow()).toBe(2500);
        setHudClockSource(null);
        expect(Math.abs(hudNow() - Date.now())).toBeLessThan(50);
    });

    it('is a real setTimeout live', () => {
        jest.useFakeTimers();
        const fn = jest.fn();
        hudAfter(fn, 5000);
        expect(nextHudTimerAt()).toBeNull();
        jest.advanceTimersByTime(4999);
        expect(fn).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('queues virtual timers by due time, ties in scheduling order', () => {
        let v = 0;
        setHudClockSource(() => v);
        const order = [];
        hudAfter(() => order.push('b'), 200);
        hudAfter(() => order.push('a'), 100);
        hudAfter(() => order.push('c'), 200);
        expect(nextHudTimerAt()).toBe(100);
        while (nextHudTimerAt() !== null) {
            v = nextHudTimerAt();
            runNextHudTimer();
        }
        expect(order).toEqual(['a', 'b', 'c']);
    });

    it('drops virtual timers on clear and when the source is removed', () => {
        setHudClockSource(() => 0);
        hudAfter(() => {}, 10);
        clearHudTimers();
        expect(nextHudTimerAt()).toBeNull();
        hudAfter(() => {}, 10);
        setHudClockSource(null);
        setHudClockSource(() => 0);
        expect(nextHudTimerAt()).toBeNull();
    });
});
