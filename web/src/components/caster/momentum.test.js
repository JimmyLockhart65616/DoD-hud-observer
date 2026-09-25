/**
 * pAlliesFromSnapshot is the one piece of translation flagswing's own tests
 * don't cover: /caster's string team/owner labels ('allies'/'axis'/'neutral')
 * onto FlagSwing's numeric convention (1/2/0). detectSwing is the
 * noise-vs-real-swing gate — get either wrong and the rail either goes silent
 * during a real swing or fires on ordinary back-and-forth.
 */
import { pAlliesFromSnapshot, detectSwing, MOMENTUM_THRESHOLD } from './momentum';

const player = (id, team, dead = false) => ({ user_id: id, team, dead });
const flag = (id, owner) => ({ flag_id: id, owner });

describe('pAlliesFromSnapshot', () => {
    it('is 0.5 with an even roster and no flags owned', () => {
        const snap = {
            alliesPlayers: [player('a1', 'allies'), player('a2', 'allies')],
            axisPlayers: [player('x1', 'axis'), player('x2', 'axis')],
            flags: [flag(0, 'neutral'), flag(1, 'neutral')],
        };
        expect(pAlliesFromSnapshot(snap)).toBeCloseTo(0.5, 9);
    });

    it('favors allies when they hold more flags', () => {
        const snap = {
            alliesPlayers: [player('a1', 'allies')],
            axisPlayers: [player('x1', 'axis')],
            flags: [flag(0, 'allies'), flag(1, 'allies'), flag(2, 'axis')],
        };
        expect(pAlliesFromSnapshot(snap)).toBeGreaterThan(0.5);
    });

    it('favors axis when allies are down players', () => {
        const snap = {
            alliesPlayers: [player('a1', 'allies', true), player('a2', 'allies', true)],
            axisPlayers: [player('x1', 'axis'), player('x2', 'axis')],
            flags: [],
        };
        expect(pAlliesFromSnapshot(snap)).toBeLessThan(0.5);
    });

    it('a dead player still counts toward roster size, just not the alive term', () => {
        const alive = pAlliesFromSnapshot({
            alliesPlayers: [player('a1', 'allies')],
            axisPlayers: [player('x1', 'axis')],
            flags: [],
        });
        const oneDead = pAlliesFromSnapshot({
            alliesPlayers: [player('a1', 'allies', true)],
            axisPlayers: [player('x1', 'axis')],
            flags: [],
        });
        expect(oneDead).toBeLessThan(alive);
    });

    it('ignores a flag owned by neither roster team', () => {
        const withNeutral = pAlliesFromSnapshot({
            alliesPlayers: [player('a1', 'allies')],
            axisPlayers: [player('x1', 'axis')],
            flags: [flag(0, 'neutral')],
        });
        expect(withNeutral).toBeCloseTo(0.5, 9);
    });
});

describe('detectSwing', () => {
    const at = (t, v) => ({ t, v });

    it('is silent with fewer than two readings', () => {
        expect(detectSwing([])).toBeNull();
        expect(detectSwing([at(0, 0.5)])).toBeNull();
    });

    it('is silent when the move is under threshold', () => {
        const history = [at(0, 0.5), at(15000, 0.5 + MOMENTUM_THRESHOLD - 0.01)];
        expect(detectSwing(history)).toBeNull();
    });

    it('fires for allies on a swing at or past threshold, toward them', () => {
        const history = [at(0, 0.4), at(15000, 0.4 + MOMENTUM_THRESHOLD)];
        const swing = detectSwing(history);
        expect(swing.team).toBe('allies');
        expect(swing.delta).toBeCloseTo(MOMENTUM_THRESHOLD, 9);
    });

    it('fires for axis on a swing the other way', () => {
        const history = [at(0, 0.6), at(15000, 0.6 - MOMENTUM_THRESHOLD - 0.02)];
        expect(detectSwing(history).team).toBe('axis');
    });

    it('compares newest to OLDEST in the window, not the previous tick', () => {
        // Three small steps that sum past threshold; a previous-tick compare
        // would see only the last, sub-threshold step and stay silent.
        const step = MOMENTUM_THRESHOLD / 2.5;
        const history = [at(0, 0.4), at(5000, 0.4 + step), at(10000, 0.4 + 2 * step), at(15000, 0.4 + 3 * step)];
        expect(detectSwing(history)).not.toBeNull();
    });
});
