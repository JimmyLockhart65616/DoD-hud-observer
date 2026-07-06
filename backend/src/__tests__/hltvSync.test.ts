/**
 * HltvSyncService unit tests
 *
 * The UDP RCON round-trip is exercised by replacing the dgram-backed
 * `rconStatus` private with a stub, but since it's an internal function we
 * test the visible behavior via dependency-free observations:
 *   - sample triggers: lazy-init on first event, map-change on cached map
 *     mismatch, no-op when not active
 *   - clock math via broadcastNow()
 *   - fallback-when-no-sample behavior
 *
 * The RCON parser regex is exercised end-to-end against a captured production
 * status response (see Phase 0b output).
 */
import { HltvSyncService, broadcastNow, HltvClock } from '../handler/hltvSync';

function fakeClock(over: Partial<HltvClock> = {}): HltvClock {
    return {
        server: 'atl1',
        cfg: { hltv_addr: '127.0.0.1', hltv_port: 27020, rcon_password: 'pw' },
        delaySeconds: 60,
        activeTime: 220,
        sampledAt: 1_000_000,
        map: 'dod_anzio',
        serverName: 'KTP - Atlanta 1',
        online: true,
        lastError: null,
        calibrationOffsetMs: 0,
        recordingState: null,
        recordingStateError: null,
        ...over,
    };
}

describe('broadcastNow()', () => {
    it('returns activeTime - delay at the sample instant', () => {
        const c = fakeClock({ activeTime: 220, delaySeconds: 60 });
        expect(broadcastNow(c, c.sampledAt)).toBe(160);
    });

    it('advances 1:1 with wall-clock', () => {
        const c = fakeClock({ activeTime: 220, delaySeconds: 60 });
        // 5 seconds of wall-clock elapses → broadcastNow advances by 5
        expect(broadcastNow(c, c.sampledAt + 5000)).toBe(165);
    });

    it('applies calibrationOffsetMs', () => {
        const c = fakeClock({ activeTime: 220, delaySeconds: 60, calibrationOffsetMs: 250 });
        expect(broadcastNow(c, c.sampledAt)).toBe(160.25);
    });
});

describe('HltvSyncService — trigger logic', () => {
    const cfg = {
        enabled: true,
        heartbeat_seconds: 0,
        fallback_delay_seconds: 60,
        board_release_lag_seconds: 10,
        coast_grace_seconds: 120,
        rcon_timeout_ms: 5000,
        api_url: '',
        api_auth_key: '',
        api_timeout_ms: 3000,
        servers: { 'atl1': { hltv_addr: '127.0.0.1', hltv_port: 27020, rcon_password: 'pw' } },
    };

    function makeServiceWithCountedSample() {
        const svc = new HltvSyncService(cfg);
        let sampleCalls: string[] = [];
        // Stub sample to avoid real UDP and just record reasons
        (svc as any).sample = async (server: string, reason: string) => {
            sampleCalls.push(`${server}:${reason}`);
            return null;
        };
        return { svc, sampleCalls: () => sampleCalls };
    }

    it('lazy-init: first event from a server triggers exactly one sample', () => {
        const { svc, sampleCalls } = makeServiceWithCountedSample();
        svc.onIngestEvent('atl1', { event: 'player_spawn' });
        svc.onIngestEvent('atl1', { event: 'kill' });
        svc.onIngestEvent('atl1', { event: 'kill' });
        expect(sampleCalls()).toEqual(['atl1:lazy_init']);
    });

    it('map change after lazy-init triggers an additional sample', () => {
        const { svc, sampleCalls } = makeServiceWithCountedSample();
        svc.onIngestEvent('atl1', { event: 'player_spawn', map: 'dod_anzio' });
        // Seed the cached clock map so map-change detection has a baseline
        (svc as any).clocks.set('atl1', fakeClock({ map: 'dod_anzio' }));
        svc.onIngestEvent('atl1', { event: 'player_spawn', map: 'dod_flash' });
        expect(sampleCalls()).toEqual(['atl1:lazy_init', 'atl1:map_change']);
    });

    it('no sample when service is disabled', () => {
        const svc = new HltvSyncService({ ...cfg, enabled: false });
        let calls = 0;
        (svc as any).sample = async () => { calls++; return null; };
        svc.onIngestEvent('atl1', { event: 'kill' });
        expect(calls).toBe(0);
    });

    it('no sample for unconfigured server', () => {
        const { svc, sampleCalls } = makeServiceWithCountedSample();
        svc.onIngestEvent('mocker', { event: 'kill' });
        expect(sampleCalls()).toEqual([]);
    });

    // Regression: at half-2 / OT changelevel on the same map, the game-server
    // tick clock resets but `event.map` doesn't change — the old map-change
    // detector missed this and the cached clock kept running with stale
    // activeTime, causing the delay buffer to fire post-reset events instantly.
    it('tick reset on the same map triggers a fresh sample and marks the clock offline', () => {
        const { svc, sampleCalls } = makeServiceWithCountedSample();
        // Lazy-init at high tick (mid-half-1).
        svc.onIngestEvent('atl1', { event: 'kill', tick: 1200, map: 'dod_anzio' });
        const onlineClock = fakeClock({ map: 'dod_anzio', online: true });
        (svc as any).clocks.set('atl1', onlineClock);

        // Ticks keep climbing through half-1 — no extra sample.
        svc.onIngestEvent('atl1', { event: 'kill', tick: 1300, map: 'dod_anzio' });
        expect(sampleCalls()).toEqual(['atl1:lazy_init']);
        expect(svc.getClock('atl1')?.online).toBe(true);

        // Half-2 starts on the same map: tick jumps back to a low value.
        svc.onIngestEvent('atl1', { event: 'half_start', tick: 5, map: 'dod_anzio' });
        expect(sampleCalls()).toEqual(['atl1:lazy_init', 'atl1:tick_reset']);
        // Clock invalidated so the buffer takes the fallback-delay path until
        // the fresh sample lands.
        expect(svc.getClock('atl1')?.online).toBe(false);

        // Subsequent low-tick events should NOT re-trigger the reset path
        // (sample is already in flight; the high-water mark was reset).
        svc.onIngestEvent('atl1', { event: 'kill', tick: 8, map: 'dod_anzio' });
        svc.onIngestEvent('atl1', { event: 'kill', tick: 12, map: 'dod_anzio' });
        expect(sampleCalls()).toEqual(['atl1:lazy_init', 'atl1:tick_reset']);
    });

    it('small tick jitter does not trigger a tick-reset sample', () => {
        const { svc, sampleCalls } = makeServiceWithCountedSample();
        svc.onIngestEvent('atl1', { event: 'kill', tick: 1000, map: 'dod_anzio' });
        (svc as any).clocks.set('atl1', fakeClock({ map: 'dod_anzio' }));
        // Out-of-order arrival within the 30s threshold — tolerated.
        svc.onIngestEvent('atl1', { event: 'kill', tick: 985, map: 'dod_anzio' });
        expect(sampleCalls()).toEqual(['atl1:lazy_init']);
    });
});

describe('HltvSyncService — getStatus', () => {
    const cfg = {
        enabled: true,
        heartbeat_seconds: 0,
        fallback_delay_seconds: 60,
        board_release_lag_seconds: 10,
        coast_grace_seconds: 120,
        rcon_timeout_ms: 5000,
        api_url: '',
        api_auth_key: '',
        api_timeout_ms: 3000,
        servers: { 'atl1': { hltv_addr: '127.0.0.1', hltv_port: 27020, rcon_password: 'pw' } },
    };

    it('reports "no sample yet" for an uninitialized server', () => {
        const svc = new HltvSyncService(cfg);
        const status = svc.getStatus();
        expect(status[0].server).toBe('atl1');
        expect(status[0].online).toBe(false);
        expect(status[0].lastError).toBe('no sample yet');
    });

    it('reports clock fields for an initialized server', () => {
        const svc = new HltvSyncService(cfg);
        (svc as any).clocks.set('atl1', fakeClock());
        const status = svc.getStatus();
        expect(status[0]).toMatchObject({
            server: 'atl1',
            hltvHost: '127.0.0.1:27020',
            delaySeconds: 60,
            activeTime: 220,
            map: 'dod_anzio',
            online: true,
        });
        expect(typeof status[0].broadcastNow).toBe('number');
    });

    it('reports lastEventTick (high-water mark) and coastGraceSeconds', () => {
        const svc = new HltvSyncService(cfg);
        (svc as any).clocks.set('atl1', fakeClock());
        (svc as any).highestEventTick.set('atl1', 1234);
        const status = svc.getStatus();
        expect(status[0].lastEventTick).toBe(1234);
        expect(status[0].coastGraceSeconds).toBe(120);
    });
});

describe('HltvSyncService.broadcastNow — offline-clock guard', () => {
    const cfg = {
        enabled: true,
        heartbeat_seconds: 0,
        fallback_delay_seconds: 60,
        board_release_lag_seconds: 10,
        coast_grace_seconds: 120,
        rcon_timeout_ms: 5000,
        api_url: '',
        api_auth_key: '',
        api_timeout_ms: 3000,
        servers: { 'atl1': { hltv_addr: '127.0.0.1', hltv_port: 27020, rcon_password: 'pw' } },
    };

    it('returns null for an unconfigured server (no clock)', () => {
        const svc = new HltvSyncService(cfg);
        expect(svc.broadcastNow('atl1')).toBeNull();
    });

    // Regression: a failed RCON sample installs a placeholder clock with
    // activeTime=0 + delaySeconds=fallback. The naive math then returns
    // a negative number and the delay buffer never fires positive-tick events.
    it('returns null for a clock whose last sample failed (online=false)', () => {
        const svc = new HltvSyncService(cfg);
        (svc as any).clocks.set('atl1', fakeClock({
            online: false,
            lastError: 'rcon timeout',
            activeTime: 0,           // placeholder default
            delaySeconds: 60,        // fallback default
            sampledAt: Date.now(),
        }));
        expect(svc.broadcastNow('atl1')).toBeNull();
    });

    it('returns the clock math when the last sample succeeded', () => {
        const svc = new HltvSyncService(cfg);
        const sampledAt = Date.now();
        (svc as any).clocks.set('atl1', fakeClock({ activeTime: 100, delaySeconds: 60, sampledAt }));
        const v = svc.broadcastNow('atl1', sampledAt);
        expect(v).toBe(40);
    });
});

describe('HltvSyncService — delaySeconds (used by the buffer to drain a boundary on the broadcast delay)', () => {
    const cfg = {
        enabled: true,
        heartbeat_seconds: 0,
        fallback_delay_seconds: 60,
        board_release_lag_seconds: 10,
        coast_grace_seconds: 120,
        rcon_timeout_ms: 5000,
        api_url: '',
        api_auth_key: '',
        api_timeout_ms: 3000,
        servers: { 'atl1': { hltv_addr: '127.0.0.1', hltv_port: 27020, rcon_password: 'pw' } },
    };

    it('returns null when no clock exists yet', () => {
        const svc = new HltvSyncService(cfg);
        expect(svc.delaySeconds('atl1')).toBeNull();
    });

    it('returns the delay for an online clock', () => {
        const svc = new HltvSyncService(cfg);
        (svc as any).clocks.set('atl1', fakeClock({ delaySeconds: 45 }));
        expect(svc.delaySeconds('atl1')).toBe(45);
    });

    // Critical for the drain: at a changelevel the clock is flipped offline
    // BEFORE the buffer drains the old-map tail, but delaySeconds is preserved
    // across the failed sample — so the drain must still read the old delay.
    it('returns the last good delay even when the clock is offline', () => {
        const svc = new HltvSyncService(cfg);
        (svc as any).clocks.set('atl1', fakeClock({ delaySeconds: 60, online: false, lastError: 'tick_reset' }));
        expect(svc.delaySeconds('atl1')).toBe(60);
    });
});

describe('HltvSyncService — clock-continuity coasting', () => {
    const cfg = {
        enabled: true,
        heartbeat_seconds: 0,
        fallback_delay_seconds: 60,
        board_release_lag_seconds: 10,
        coast_grace_seconds: 120,
        rcon_timeout_ms: 5000,
        api_url: '',
        api_auth_key: '',
        api_timeout_ms: 3000,
        servers: { 'atl1': { hltv_addr: '127.0.0.1', hltv_port: 27020, rcon_password: 'pw' } },
    };

    const okStatus = { delaySeconds: 60, activeTime: 220, map: 'dod_anzio', serverName: 'KTP - Atlanta 1' };

    function makeService(fetchImpl: () => Promise<any>) {
        const svc = new HltvSyncService(cfg);
        (svc as any).fetchStatus = fetchImpl;
        return svc;
    }

    it('coasts a transient failure within grace: clock stays online, broadcastNow keeps advancing', async () => {
        const svc = makeService(async () => { throw new Error('rcon timeout'); });
        // Healthy clock from 30s ago (within the 120s grace).
        (svc as any).clocks.set('atl1', fakeClock({ online: true, sampledAt: Date.now() - 30_000 }));
        await svc.sample('atl1', 'heartbeat');
        expect(svc.getClock('atl1')?.online).toBe(true);          // coasting, not flipped offline
        expect(svc.broadcastNow('atl1')).not.toBeNull();          // buffer stays on the broadcast path
    });

    it('gives up to fallback once a failure outlasts the grace window', async () => {
        const svc = makeService(async () => { throw new Error('rcon timeout'); });
        // Last good sample 130s ago (> 120s grace).
        (svc as any).clocks.set('atl1', fakeClock({ online: true, sampledAt: Date.now() - 130_000 }));
        await svc.sample('atl1', 'heartbeat');
        expect(svc.getClock('atl1')?.online).toBe(false);         // fallback engages
        expect(svc.broadcastNow('atl1')).toBeNull();
    });

    it('never coasts a map_change failure (its activeTime is for the wrong map)', async () => {
        const svc = makeService(async () => { throw new Error('rcon timeout'); });
        (svc as any).clocks.set('atl1', fakeClock({ online: true, sampledAt: Date.now() - 1_000 }));
        await svc.sample('atl1', 'map_change');
        expect(svc.getClock('atl1')?.online).toBe(false);
    });

    // Boundary-fix regression guard: tick_reset flips online=false in onIngestEvent
    // BEFORE the resample runs, so a failed tick_reset resample must NOT coast back
    // online (that would defeat the delay-buffer drain at a changelevel).
    it('does not coast back online when the previous clock was already offline (tick_reset)', async () => {
        const svc = makeService(async () => { throw new Error('rcon timeout'); });
        (svc as any).clocks.set('atl1', fakeClock({ online: false, sampledAt: Date.now() - 1_000 }));
        await svc.sample('atl1', 'tick_reset');
        expect(svc.getClock('atl1')?.online).toBe(false);
    });

    it('logs a resync step when a fresh sample disagrees with the coasted projection', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            // prev projects to 40 now; fresh sample's activeTime is +10s → projects to 50.
            const svc = makeService(async () => ({ ...okStatus, activeTime: 110, delaySeconds: 60 }));
            (svc as any).clocks.set('atl1', fakeClock({ online: true, activeTime: 100, delaySeconds: 60, sampledAt: Date.now() }));
            await svc.sample('atl1', 'heartbeat');
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('resync step'));
        } finally {
            warn.mockRestore();
        }
    });

    it('does NOT log a resync step for a normal heartbeat that advanced consistently', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            // 60s ago activeTime=160; a healthy sample now reads 220 (advanced 60s) → step ~0.
            const svc = makeService(async () => ({ ...okStatus, activeTime: 220, delaySeconds: 60 }));
            (svc as any).clocks.set('atl1', fakeClock({ online: true, activeTime: 160, delaySeconds: 60, sampledAt: Date.now() - 60_000 }));
            await svc.sample('atl1', 'heartbeat');
            expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('resync step'));
        } finally {
            warn.mockRestore();
        }
    });
});

describe('HltvSyncService — tail basis capture (changelevel projection anchor)', () => {
    const cfg = {
        enabled: true,
        heartbeat_seconds: 0,
        fallback_delay_seconds: 60,
        board_release_lag_seconds: 10,
        coast_grace_seconds: 120,
        rcon_timeout_ms: 5000,
        api_url: '',
        api_auth_key: '',
        api_timeout_ms: 3000,
        servers: { 'atl1': { hltv_addr: '127.0.0.1', hltv_port: 27020, rcon_password: 'pw' } },
    };

    const basisA = { activeTime: 100, sampledAt: 5_000_000, delaySeconds: 60, calibrationOffsetMs: 0 };

    function makeService() {
        const svc = new HltvSyncService(cfg);
        const sampleCalls: string[] = [];
        (svc as any).sample = async (server: string, reason: string) => {
            sampleCalls.push(`${server}:${reason}`);
            return null;
        };
        return { svc, sampleCalls };
    }

    // Builds the standard mid-half-1 state: clock A live, paired with tick'd
    // events up to tick 1010.
    function midHalf1() {
        const { svc, sampleCalls } = makeService();
        svc.onIngestEvent('atl1', { event: 'kill', tick: 1000, map: 'dod_anzio' }); // lazy-init (no clock yet)
        (svc as any).clocks.set('atl1', fakeClock({ activeTime: 100, sampledAt: 5_000_000, delaySeconds: 60, map: 'dod_anzio' }));
        svc.onIngestEvent('atl1', { event: 'kill', tick: 1010, map: 'dod_anzio' }); // pairs clock A
        return { svc, sampleCalls };
    }

    it('tailBasis is null before any clock has been paired with an event', () => {
        const { svc } = makeService();
        svc.onIngestEvent('atl1', { event: 'kill', tick: 1000, map: 'dod_anzio' });
        expect(svc.tailBasis('atl1')).toBeNull();
    });

    it('pairs the online clock with tick\'d events (lastEventClock fallback)', () => {
        const { svc } = midHalf1();
        expect(svc.tailBasis('atl1')).toEqual(basisA);
    });

    it('tick-less events do not update the snapshot (they cannot witness the level instance)', () => {
        const { svc } = midHalf1();
        // Live clock re-anchors (e.g. a heartbeat mid-changelevel)…
        (svc as any).clocks.set('atl1', fakeClock({ activeTime: 4, sampledAt: 6_000_000, map: 'dod_anzio' }));
        // …then a tick-less event arrives. It must not pair the new clock.
        svc.onIngestEvent('atl1', { event: 'time_sync', map: 'dod_anzio' });
        expect(svc.tailBasis('atl1')).toEqual(basisA);
    });

    it('offline clocks do not update the snapshot (post-reset events before the resample)', () => {
        const { svc } = midHalf1();
        (svc as any).clocks.set('atl1', fakeClock({ online: false, activeTime: 3, sampledAt: 6_000_000, map: 'dod_anzio' }));
        svc.onIngestEvent('atl1', { event: 'kill', tick: 1020, map: 'dod_anzio' });
        expect(svc.tailBasis('atl1')).toEqual(basisA);
    });

    // The heartbeat-mid-changelevel race: by the time the first half-2 event
    // triggers tick_reset, a heartbeat may have already re-anchored the live
    // clock to the new map. The promoted basis must be the clock as of the
    // last OLD-map event — not the live clock at detection time.
    it('tick_reset promotes the last-event snapshot even when the live clock already re-anchored', () => {
        const { svc, sampleCalls } = midHalf1();
        (svc as any).clocks.set('atl1', fakeClock({ activeTime: 4, sampledAt: 6_000_000, map: 'dod_anzio' }));
        svc.onIngestEvent('atl1', { event: 'half_start', tick: 3, map: 'dod_anzio' });   // tick_reset
        expect(sampleCalls).toContain('atl1:tick_reset');
        expect(svc.tailBasis('atl1')).toEqual(basisA);
        // New-map tick'd events refresh lastEventClock, but the promoted
        // boundary basis keeps precedence for the old tail.
        svc.onIngestEvent('atl1', { event: 'kill', tick: 8, map: 'dod_anzio' });
        expect(svc.tailBasis('atl1')).toEqual(basisA);
    });

    it('map_change promotes the snapshot too', () => {
        const { svc, sampleCalls } = midHalf1();
        svc.onIngestEvent('atl1', { event: 'kill', tick: 5, map: 'dod_flash' });
        expect(sampleCalls).toContain('atl1:map_change');
        expect(svc.tailBasis('atl1')).toEqual(basisA);
    });

    // A late old-half POST (curl stall) arriving after half-2 began: it must
    // be classified old-epoch, must not raise the tick high-water mark (which
    // would fire a spurious tick_reset on the next fresh event), and must not
    // re-pair the snapshot.
    it('old-epoch stragglers are classified and do not pollute the high-water mark', () => {
        const { svc, sampleCalls } = midHalf1();
        svc.onIngestEvent('atl1', { event: 'half_start', tick: 3, map: 'dod_anzio' });   // boundary
        // Fresh re-anchored clock: sampledAt must be "now" — oldEpochTick's
        // ambiguity guard projects current game time from (activeTime, sampledAt).
        (svc as any).clocks.set('atl1', fakeClock({ activeTime: 6, sampledAt: Date.now(), map: 'dod_anzio' }));

        expect(svc.oldEpochTick('atl1', 1005)).toBe(true);   // near the old tail (1010)
        svc.onIngestEvent('atl1', { event: 'kill', tick: 1005, map: 'dod_anzio' });      // straggler
        expect(svc.tailBasis('atl1')).toEqual(basisA);       // no re-pairing with clock B

        // Next fresh event: high-water is still 3, so NO spurious tick_reset.
        svc.onIngestEvent('atl1', { event: 'kill', tick: 10, map: 'dod_anzio' });
        expect(sampleCalls.filter(s => s === 'atl1:tick_reset')).toHaveLength(1);
    });

    it('rejects the warmup-silence look-alike: a forward jump far below the old tail is NOT a straggler', () => {
        const { svc } = midHalf1();
        svc.onIngestEvent('atl1', { event: 'half_start', tick: 3, map: 'dod_anzio' });   // boundary (old tail 1010)
        // 200s into the new level after a long quiet warmup: forward jump vs
        // high-water 3, but nowhere near the old tail — legitimate new-level tick.
        expect(svc.oldEpochTick('atl1', 200)).toBe(false);
    });

    it('no boundary on record → never classified (pre-boundary stragglers ride the rescue path)', () => {
        const { svc } = midHalf1();
        expect(svc.oldEpochTick('atl1', 1005)).toBe(false);
    });
});

describe('HltvSyncService — calibration', () => {
    const cfg = {
        enabled: true,
        heartbeat_seconds: 0,
        fallback_delay_seconds: 60,
        board_release_lag_seconds: 10,
        coast_grace_seconds: 120,
        rcon_timeout_ms: 5000,
        api_url: '',
        api_auth_key: '',
        api_timeout_ms: 3000,
        servers: { 'atl1': { hltv_addr: '127.0.0.1', hltv_port: 27020, rcon_password: 'pw' } },
    };

    it('setCalibrationOffsetMs updates the cached clock and emits', () => {
        const svc = new HltvSyncService(cfg);
        (svc as any).clocks.set('atl1', fakeClock());
        let emitted = 0;
        svc.on('clock', () => emitted++);
        svc.setCalibrationOffsetMs('atl1', 350);
        expect(svc.getClock('atl1')?.calibrationOffsetMs).toBe(350);
        expect(emitted).toBe(1);
    });

    it('setCalibrationOffsetMs is a no-op for an uninitialized server', () => {
        const svc = new HltvSyncService(cfg);
        svc.setCalibrationOffsetMs('atl1', 350);
        expect(svc.getClock('atl1')).toBeNull();
    });
});
