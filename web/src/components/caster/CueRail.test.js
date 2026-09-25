/**
 * threatKind decides whether an in-progress flag capture is worth a cue: would
 * completing it sweep the whole board, or leave the other side defending their
 * last flag? Everything else — an ordinary capture with plenty of flags left
 * either way — must stay silent, or the rail is noise a caster tunes out.
 */
import { threatKind } from './CueRail';

const flags = (owners) => owners.map((owner, i) => ({ flag_id: i, owner }));

describe('threatKind', () => {
    it('calls sweep when every other flag is already the capping team\'s', () => {
        const f = flags(['allies', 'allies', 'allies', 'allies']);
        expect(threatKind(f, 3, 'allies')).toBe('sweep');
    });

    it('calls last_flag when completing it leaves exactly one flag to the other side', () => {
        const f = flags(['allies', 'allies', 'axis', 'axis']);
        // Capturing flag 2 for allies leaves axis holding only flag 3.
        expect(threatKind(f, 2, 'allies')).toBe('last_flag');
    });

    it('is silent on an ordinary capture with flags to spare either way', () => {
        const f = flags(['allies', 'neutral', 'axis', 'axis', 'neutral']);
        expect(threatKind(f, 1, 'allies')).toBeNull();
    });

    it('is silent capturing your own already-owned flag (recapture, not a threat)', () => {
        const f = flags(['allies', 'neutral', 'axis']);
        expect(threatKind(f, 0, 'allies')).toBeNull();
    });

    it('has no silent case on a two-flag map — every capture is already decisive', () => {
        // Neutral + axis: taking the neutral one still leaves axis on the other.
        expect(threatKind(flags(['neutral', 'axis']), 0, 'allies')).toBe('last_flag');
        // Already holding one: taking axis's flag completes the pair.
        expect(threatKind(flags(['allies', 'axis']), 1, 'allies')).toBe('sweep');
    });

    it('returns null with no flags known yet', () => {
        expect(threatKind([], 0, 'allies')).toBeNull();
    });
});
