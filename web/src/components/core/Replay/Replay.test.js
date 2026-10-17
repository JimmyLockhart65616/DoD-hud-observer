import { monotonicClock } from './Replay';

// `tick` is get_gametime() and resets at the halftime changelevel, so a tick sort
// interleaves the halves. These shapes are taken from real archived matches.
describe('monotonicClock', () => {
    it('keeps file order when the second half restarts its tick clock', () => {
        const events = [
            { half: 1, tick: 1.0, plugin_sent_at: 1000 },
            { half: 1, tick: 1790.4, plugin_sent_at: 1790000 },
            { half: 2, tick: 184.51, plugin_sent_at: 1973000 },
            { half: 2, tick: 1403.41, plugin_sent_at: 3192000 },
        ];
        const clock = monotonicClock(events);
        expect(clock).toEqual([1000, 1790000, 1973000, 3192000]);
        // a tick sort would have put the half-2 opener second; the clock must not
        expect(clock[2]).toBeGreaterThan(clock[1]);
    });

    it('CONTROL: the tick sort this replaced really does interleave the halves', () => {
        // Without this the suite would only prove the new helper self-consistent.
        const events = [
            { half: 1, tick: 1.0, plugin_sent_at: 1000 },
            { half: 1, tick: 1790.4, plugin_sent_at: 1790000 },
            { half: 2, tick: 184.51, plugin_sent_at: 1973000 },
            { half: 2, tick: 1403.41, plugin_sent_at: 3192000 },
        ];
        const flips = seq => seq.reduce(
            (n, e, i) => (i && e.half !== seq[i - 1].half ? n + 1 : n), 0);
        expect(flips(events)).toBe(1);
        const byTick = [...events].sort((a, b) => (a.tick || 0) - (b.tick || 0));
        expect(flips(byTick)).toBeGreaterThan(1);
    });

    it('does not move an event earlier when a stamp steps backward', () => {
        // measured: 6 such events on 1.3-7057-NY1, 0 on 1792187593-NY1
        const clock = monotonicClock([
            { plugin_sent_at: 5000 },
            { plugin_sent_at: 4000 },
            { plugin_sent_at: 6000 },
        ]);
        expect(clock).toEqual([5000, 5000, 6000]);
        for (let i = 1; i < clock.length; i++) {
            expect(clock[i]).toBeGreaterThanOrEqual(clock[i - 1]);
        }
    });

    it('tolerates a missing stamp and an empty list', () => {
        expect(monotonicClock([])).toEqual([]);
        expect(monotonicClock([{ plugin_sent_at: 7000 }, {}, { plugin_sent_at: 8000 }]))
            .toEqual([7000, 7000, 8000]);
    });
});
