import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { replayTimeline } from './replayClock';
import {
    buildClockTimeline, clockAt, findClock, parseClock, formatClock, halfLabel,
} from './demoClock';

// Two real archived matches (e2e/repro/fixtures). CHI1-1783302239 is the one
// whose post-halftime warmup clock passes through the same 19:47 its first half
// read, with every one of those warmup time_syncs still stamped `half: 1`.
const FIXTURES = path.resolve(__dirname, '../../../../../e2e/repro/fixtures');

function load(name) {
    const raw = zlib.gunzipSync(fs.readFileSync(path.join(FIXTURES, name))).toString();
    const events = raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
    const { clock, mapOf } = replayTimeline(events);
    return { events, clock, mapOf, timeline: buildClockTimeline(events, clock, mapOf) };
}

const matches = {
    'match-1782879518-CHI1.jsonl.gz': load('match-1782879518-CHI1.jsonl.gz'),
    'match-1783302239-CHI1.jsonl.gz': load('match-1783302239-CHI1.jsonl.gz'),
};

describe('demo clock on recorded matches', () => {
    Object.entries(matches).forEach(([name, m]) => {
        describe(name, () => {
            it('finds both halves, each on its own map', () => {
                expect(m.timeline.map(h => h.half)).toEqual([1, 2]);
                expect(m.timeline[0].map).not.toBe(m.timeline[1].map);
                expect(m.timeline[0].end).toBeLessThanOrEqual(m.timeline[1].start);
            });

            it('lands on the typed clock for every second it can find, in both halves', () => {
                m.timeline.forEach(h => {
                    const top = Math.floor(h.anchors[0].timeleft);
                    let found = 0;
                    for (let s = top; s >= 0; s--) {
                        const v = findClock(m.timeline, h.half, s);
                        if (v == null) continue;
                        found++;
                        expect(clockAt(m.timeline, v)).toEqual({ half: h.half, seconds: s });
                        // and it is the FIRST instant reading s: a millisecond earlier reads s+1
                        const before = clockAt(m.timeline, v - 2);
                        if (before && before.half === h.half && v - 2 >= h.anchors[0].v) {
                            expect(before.seconds).toBeGreaterThanOrEqual(s);
                        }
                    }
                    // A time_sync re-anchor can step the clock past a second, so not
                    // every value is shown, but nearly all are.
                    expect(found).toBeGreaterThan(top * 0.97);
                });
            });

            it('refuses a clock the half never showed', () => {
                expect(findClock(m.timeline, 2, 25 * 60)).toBeNull();
                expect(findClock(m.timeline, 101, 600)).toBeNull();
            });
        });
    });

    it('does not mistake the halftime warmup clock for the first half', () => {
        const m = matches['match-1783302239-CHI1.jsonl.gz'];
        // index 143: H1's real 19:47 sync; 6843: the new map's warmup reading 19:47
        expect(m.events[143]).toMatchObject({ event: 'time_sync', half: 1, timeleft: 1187 });
        expect(m.events[6843]).toMatchObject({ event: 'time_sync', half: 1, timeleft: 1187 });
        const v = findClock(m.timeline, 1, 1187);
        expect(v).toBeLessThan(m.clock[1000]);
        // during that warmup no half is running, so there is no demo reading
        expect(clockAt(m.timeline, m.clock[6500])).toBeNull();
    });
});

describe('demo clock helpers', () => {
    it('parses what a viewer types', () => {
        expect(parseClock('14:32')).toBe(872);
        expect(parseClock('1432')).toBe(872);
        expect(parseClock(' 9:05 ')).toBe(545);
        expect(parseClock('0:00')).toBe(0);
        expect(parseClock('9:75')).toBeNull();
        expect(parseClock('abc')).toBeNull();
        expect(parseClock('')).toBeNull();
    });

    it('formats and labels like the overlay', () => {
        expect(formatClock(872)).toBe('14:32');
        expect(formatClock(5)).toBe('0:05');
        expect(halfLabel(1)).toBe('H1');
        expect(halfLabel(2)).toBe('H2');
        expect(halfLabel(101)).toBe('OT1');
    });

    it('takes the half from the envelope when the recording began mid-half', () => {
        const events = [
            { event: 'time_sync', half: 2, timeleft: 600, tick: 100, plugin_sent_at: 100000 },
            { event: 'kill', half: 2, tick: 110, plugin_sent_at: 110000 },
        ];
        const { clock, mapOf } = replayTimeline(events);
        const tl = buildClockTimeline(events, clock, mapOf);
        expect(tl.map(h => h.half)).toEqual([2]);
        expect(clockAt(tl, clock[1])).toEqual({ half: 2, seconds: 590 });
        expect(findClock(tl, 2, 595)).toBe(clock[0] + 4001);
    });
});
