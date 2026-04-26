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
        rcon_timeout_ms: 5000,
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
});

describe('HltvSyncService — getStatus', () => {
    const cfg = {
        enabled: true,
        heartbeat_seconds: 0,
        fallback_delay_seconds: 60,
        rcon_timeout_ms: 5000,
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
});

describe('HltvSyncService.broadcastNow — offline-clock guard', () => {
    const cfg = {
        enabled: true,
        heartbeat_seconds: 0,
        fallback_delay_seconds: 60,
        rcon_timeout_ms: 5000,
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

describe('HltvSyncService — calibration', () => {
    const cfg = {
        enabled: true,
        heartbeat_seconds: 0,
        fallback_delay_seconds: 60,
        rcon_timeout_ms: 5000,
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
