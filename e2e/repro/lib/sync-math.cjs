// Pure derived-formula math for the HLTV↔overlay sync probes.
//
// No I/O, no deps — so segment-probe.cjs / relay-probe.cjs AND the Jest spec
// (backend/src/__tests__/syncMath.test.ts) share one source of truth for the
// offset arithmetic. Every fn is null-safe: any null/undefined/NaN input → null
// (detectStep returns { isStep:false, jump:null }).
//
// Reference points (all in game-server "seconds since map load", except timeleft
// which is the half countdown clock):
//   • lastEventTick   — newest plugin event tick = the LIVE game clock (lagged
//                       only by POST latency).
//   • broadcastNow    — the overlay's release clock = live − delaySeconds (+calib).
//   • proxyGameTime   — MASTER proxy rcon "Game Time" = its view of LIVE.
//   • relayGameTime   — a delay-0 RELAY's rcon "Game Time" = the frames it has
//                       received from the master = the master's SERVE point.
'use strict';

const isNum = (v) => typeof v === 'number' && !Number.isNaN(v);

// lastEventTick − broadcastNow. Should ≈ delaySeconds: the buffer holds each
// event ~delay behind live ([hltvDelayBuffer] release gate). ≠ delay ⇒ buffer
// math is wrong.
function overlayLag(lastEventTick, broadcastNow) {
    if (!isNum(lastEventTick) || !isNum(broadcastNow)) return null;
    return lastEventTick - broadcastNow;
}

// broadcastNow − (lastEventTick − delay). ≈ POST latency (~1–2s) in steady
// state; a large/growing value is a real offset bug.
function clockErr(broadcastNow, lastEventTick, delay) {
    if (!isNum(broadcastNow) || !isNum(lastEventTick) || !isNum(delay)) return null;
    return broadcastNow - (lastEventTick - delay);
}

// broadcastNow − (proxyGameTime − delay). Our broadcast clock vs where the
// MASTER proxy's own (live) clock says the feed should be. ~0 ± sampleAge drift
// is healthy; a linear drift = backend-host vs game-server-host clock skew.
function clockErrPx(broadcastNow, proxyGameTime, delay) {
    if (!isNum(broadcastNow) || !isNum(proxyGameTime) || !isNum(delay)) return null;
    return broadcastNow - (proxyGameTime - delay);
}

// liveGameTime − relayGameTime = the master's effective SERVE-delay to a fresh
// joiner. liveGameTime = the master's own rcon Game Time (= live). A relay's
// Game Time lags by however far back the master actually broadcasts — the number
// the reported `Delay` cvar does NOT capture.
function proxySrvDelay(liveGameTime, relayGameTime) {
    if (!isNum(liveGameTime) || !isNum(relayGameTime)) return null;
    return liveGameTime - relayGameTime;
}

// THE discriminator: relayGameTime − broadcastNow. Both are "live − their delay".
//   ≈ 0  → overlay matches the master serve point; any residual gap to the
//          caster's footage is CLIENT-side (a relay can't see it) → the mechanism
//          is correct relative to the proxy; fix = per-session calibration.
//   ≪ 0  → master serves much further back than the overlay → mechanism reference
//          is WRONG (relay hop / delay>configured / buffer) → PROXY-side gap,
//          auto-fixable by feeding the measured serve-delay into the buffer.
function relayVsOverlay(relayGameTime, broadcastNow) {
    if (!isNum(relayGameTime) || !isNum(broadcastNow)) return null;
    return relayGameTime - broadcastNow;
}

// yourClientTimeleft − hudTimeleft (both half-countdown seconds). >0 ⇒ your
// client has MORE time left ⇒ the overlay is AHEAD of the footage by that much.
function spectatorGap(yourClientTimeleft, hudTimeleft) {
    if (!isNum(yourClientTimeleft) || !isNum(hudTimeleft)) return null;
    return yourClientTimeleft - hudTimeleft;
}

// broadcastNow jump > threshold between consecutive samples with NO lastEventTick
// reset = the failed-sample-resume signature. The tolerance widens by the sample
// interval so normal 1:1 advancement never trips it. A tick drop > 30s is a
// legit half-2/OT/map-change reset and is excluded.
function detectStep(prevBcast, bcast, prevTick, lastTick, intervalMs, thresholdS) {
    if (thresholdS == null) thresholdS = 2;
    if (!isNum(prevBcast) || !isNum(bcast)) return { isStep: false, jump: null };
    const jump = bcast - prevBcast;
    const tickReset = isNum(prevTick) && isNum(lastTick) && prevTick - lastTick > 30;
    const tol = thresholdS + (isNum(intervalMs) ? intervalMs / 1000 : 0);
    return { isStep: Math.abs(jump) > tol && !tickReset, jump };
}

// seconds → "M:SS" (for the countdown timer columns). null/NaN → "   -".
function mmss(s) {
    if (!isNum(s)) return '   -';
    const sign = s < 0 ? '-' : '';
    const a = Math.abs(Math.floor(s));
    return `${sign}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
}

module.exports = {
    overlayLag, clockErr, clockErrPx, proxySrvDelay, relayVsOverlay,
    spectatorGap, detectStep, mmss,
};
