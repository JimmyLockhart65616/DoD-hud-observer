import { replayClock } from './Replay';

// `tick` is get_gametime() and resets at the halftime changelevel, so a tick sort
// interleaves the halves. `plugin_sent_at` is stamped from get_systime(), so it only
// moves in whole seconds. These shapes are taken from real archived matches.
describe('replayClock', () => {
    it('keeps file order when the second half restarts its tick clock', () => {
        const events = [
            { half: 1, tick: 1.0, plugin_sent_at: 1000 },
            { half: 1, tick: 1790.4, plugin_sent_at: 1790000 },
            { half: 2, tick: 184.51, plugin_sent_at: 1973000 },
            { half: 2, tick: 1403.41, plugin_sent_at: 3192000 },
        ];
        const clock = replayClock(events);
        // tick-precise within each half; the second half is placed by its wall stamp
        expect(clock).toEqual([1000, 1790400, 1973000, 3191900]);
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

    it('keeps sub-second spacing that plugin_sent_at floors away', () => {
        // Three rows inside two wall-clock seconds: a wall-only clock fires the
        // first two together and the third a full second later.
        const clock = replayClock([
            { tick: 10.10, plugin_sent_at: 50000 },
            { tick: 10.85, plugin_sent_at: 50000 },
            { tick: 11.20, plugin_sent_at: 51000 },
        ]);
        expect(clock[1] - clock[0]).toBe(750);
        expect(clock[2] - clock[1]).toBe(350);
    });

    it('holds a late row from the previous map instead of jumping to its old tick', () => {
        // Shape of every recorded halftime: the old map's final player_disconnect
        // rows arrive interleaved with the new map's first rows.
        const clock = replayClock([
            { tick: 1480.88, plugin_sent_at: 1480000 },
            { tick: 1.00, plugin_sent_at: 1480000 },
            { tick: 1480.88, plugin_sent_at: 1480000 },
            { tick: 2.04, plugin_sent_at: 1481000 },
        ]);
        expect(clock[2]).toBe(clock[1]);
        expect(clock[3] - clock[1]).toBe(1040);
    });

    it('holds an arrival reorder inside a map', () => {
        // Each event is its own curl request, so a row can land before a
        // lower-tick predecessor; within one arming the clock can only rise.
        const clock = replayClock([
            { tick: 10.50, plugin_sent_at: 20000 },
            { tick: 10.21, plugin_sent_at: 20000 },
            { tick: 10.60, plugin_sent_at: 20000 },
        ]);
        expect(clock).toEqual([20000, 20000, 20100]);
    });

    it('does not move an event earlier when a stamp steps backward', () => {
        // measured: 6 such events on 1.3-7057-NY1, 0 on 1792187593-NY1
        const clock = replayClock([
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
        expect(replayClock([])).toEqual([]);
        expect(replayClock([{ plugin_sent_at: 7000 }, {}, { plugin_sent_at: 8000 }]))
            .toEqual([7000, 7000, 8000]);
        expect(replayClock([{}, { plugin_sent_at: 7000 }, {}, { plugin_sent_at: 8000 }]))
            .toEqual([7000, 7000, 7000, 8000]);
    });
});
