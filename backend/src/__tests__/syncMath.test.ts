// Gate the HLTV↔overlay sync-probe formula math (e2e/repro/lib/sync-math.cjs).
// These pure functions are the offset arithmetic the segment/relay probes report;
// a sign flip or off-by-delay here would silently mis-attribute the drift. Kept in
// the backend Jest suite so `npm run test` covers them. The probes are plain
// Node .cjs (no TS build), so we require the module directly.
/* eslint-disable @typescript-eslint/no-var-requires */
const M = require('../../../e2e/repro/lib/sync-math.cjs');

describe('sync-math derived formulas', () => {
    test('overlayLag = lastEventTick − broadcastNow (≈ delay when healthy)', () => {
        expect(M.overlayLag(1200, 1140)).toBe(60);
        expect(M.overlayLag(1200, 1200)).toBe(0);
    });

    test('clockErr = broadcastNow − (lastEventTick − delay) (≈ POST latency)', () => {
        // healthy: broadcastNow sits ~1.5s ahead of the ideal (lastTick − delay)
        expect(M.clockErr(1141.5, 1200, 60)).toBeCloseTo(1.5, 5);
        expect(M.clockErr(1140, 1200, 60)).toBe(0);
    });

    test('clockErrPx = broadcastNow − (proxyGameTime − delay) (host clock skew)', () => {
        expect(M.clockErrPx(1140, 1200, 60)).toBe(0); // proxy live clock agrees
        expect(M.clockErrPx(1142, 1200, 60)).toBe(2); // backend 2s ahead of game-server host
    });

    test('proxySrvDelay = liveGameTime − relayGameTime (master serve-delay)', () => {
        expect(M.proxySrvDelay(1200, 1140)).toBe(60);   // serves at live−60
        expect(M.proxySrvDelay(1200, 1009)).toBe(191);  // serves much further back
    });

    test('relayVsOverlay discriminator: ≈0 client-side, ≪0 proxy-side', () => {
        // master serves at live−60, overlay also at live−60 → gap is client-side
        expect(M.relayVsOverlay(1140, 1140)).toBe(0);
        // master serves at live−191 but overlay at live−60 → proxy-side, strongly negative
        expect(M.relayVsOverlay(1009, 1140)).toBe(-131);
    });

    test('spectatorGap = yourClientTimeleft − hudTimeleft (>0 ⇒ overlay AHEAD)', () => {
        // client shows 5:05 (305), HUD shows 2:54 (174) → overlay 131s ahead
        expect(M.spectatorGap(305, 174)).toBe(131);
    });

    test('detectStep flags a broadcastNow jump with no tick reset', () => {
        // +30s jump, ticks steady, 2s interval → STEP
        expect(M.detectStep(1140, 1170, 1200, 1202, 2000).isStep).toBe(true);
        // normal 1:1 advance (~2s) over a 2s interval → not a step
        expect(M.detectStep(1140, 1142, 1200, 1202, 2000).isStep).toBe(false);
        // big drop BUT lastEventTick reset >30s (half-2/OT/map change) → excluded
        expect(M.detectStep(1140, 40, 1200, 5, 2000).isStep).toBe(false);
    });

    test('null/NaN inputs propagate to null (no false readings)', () => {
        expect(M.overlayLag(null, 1140)).toBeNull();
        expect(M.clockErrPx(1140, null, 60)).toBeNull();
        expect(M.proxySrvDelay(1200, undefined)).toBeNull();
        expect(M.relayVsOverlay(NaN, 1140)).toBeNull();
        expect(M.detectStep(null, 1140, 1200, 1202, 2000)).toEqual({ isStep: false, jump: null });
    });

    test('mmss formats countdown seconds', () => {
        expect(M.mmss(174)).toBe('2:54');
        expect(M.mmss(305)).toBe('5:05');
        expect(M.mmss(null)).toBe('   -');
    });
});
