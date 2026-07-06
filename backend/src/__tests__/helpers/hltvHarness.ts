/**
 * Fake-timer harness for the HLTV sync/buffer subsystem.
 *
 * Wires the REAL trio together — HltvSyncService + HltvDelayBuffer +
 * wireStrandedRescue — and stubs only the network seam (fetchStatus), which
 * reads a scripted FakeProxy whose Game Time advances on jest's faked clock.
 * This exists because every real bug in this subsystem (boundary instant
 * flush, negative broadcastNow, rescue-before-basis-promotion, the
 * heartbeat-mid-changelevel re-anchor) lived in the temporal coupling
 * BETWEEN the components — which per-component stubs erase by construction.
 * Rule for this subsystem: stub at the network seam, never between the trio.
 *
 * Time model: jest modern fake timers (Date.now faked). advance() steps the
 * clock in 250ms slices, flushing microtasks between slices so sample()'s
 * promise chain resolves at the right faked instants. Event ticks are game
 * seconds since map load, i.e. FakeProxy.gameTime() at capture time — the
 * same clock the plugin's do_send_json() stamps.
 */
import { HltvSyncService, HltvSyncConfig } from '../../handler/hltvSync';
import { HltvDelayBuffer, wireStrandedRescue } from '../../handler/hltvDelayBuffer';

export const SERVER = 'harness-srv';

// Scripted stand-in for the HLTV proxy's RCON `status` surface. Game Time is
// wall-anchored (mapStartWall) so it advances 1:1 with the faked clock;
// changelevel() re-anchors it to 0 — the same observable a real proxy exposes
// across the halftime map reload.
export class FakeProxy {
    delaySeconds = 60;
    map = 'dod_anzio';
    failing = false;
    mapStartWall: number;

    constructor(initialGameTimeSeconds = 0) {
        this.mapStartWall = Date.now() - initialGameTimeSeconds * 1000;
    }

    changelevel(map?: string): void {
        this.mapStartWall = Date.now();
        if (map) this.map = map;
    }

    gameTime(): number {
        return (Date.now() - this.mapStartWall) / 1000;
    }

    status(): { delaySeconds: number; activeTime: number; map: string; serverName: string } {
        if (this.failing) throw new Error('rcon timeout (scripted)');
        // Real proxies report Game Time in whole seconds (MM:SS).
        return {
            delaySeconds: this.delaySeconds,
            activeTime: Math.floor(this.gameTime()),
            map: this.map,
            serverName: SERVER,
        };
    }
}

// An event captured at its live instant. capture() → deliver() lets a test
// separate creation (tick stamped) from POST arrival (enqueue) — the curl
// stall the projection must be immune to.
export interface EventToken {
    id: number;
    name: string;
    tick: number;
    event: any;
    epoch: number;             // which map instance it was created on
    mapStartWall: number;      // wall-clock when that instance loaded
    delaySeconds: number;      // proxy delay at creation
    createdAtWall: number;
    isBoard: boolean;
}

export interface PostRecord {
    token: EventToken;
    arrivedAtWall: number;
}

export interface FiredRecord {
    id: number;
    event: any;
    firedAt: number;
}

export interface Harness {
    sync: HltvSyncService;
    buffer: HltvDelayBuffer;
    proxy: FakeProxy;
    fired: FiredRecord[];
    posts: PostRecord[];
    heartbeatMs: number;
    boardLagMs: number;
    fallbackMs: number;
    epoch: () => number;
    capture: (name: string, over?: any) => EventToken;
    deliver: (token: EventToken) => void;
    post: (name: string, over?: any) => EventToken;   // capture + deliver now
    changelevel: (map?: string) => void;
    unwire: () => void;
    stop: () => void;
}

export function makeHarness(opts: {
    heartbeatSeconds?: number;
    boardLagSeconds?: number;
    fallbackSeconds?: number;
    coastGraceSeconds?: number;
    initialGameTime?: number;
    delaySeconds?: number;
} = {}): Harness {
    const proxy = new FakeProxy(opts.initialGameTime ?? 0);
    proxy.delaySeconds = opts.delaySeconds ?? 60;

    const cfg: HltvSyncConfig = {
        enabled: true,
        heartbeat_seconds: opts.heartbeatSeconds ?? 20,
        fallback_delay_seconds: opts.fallbackSeconds ?? 60,
        board_release_lag_seconds: opts.boardLagSeconds ?? 10,
        coast_grace_seconds: opts.coastGraceSeconds ?? 120,
        rcon_timeout_ms: 1000,
        api_url: '',
        api_auth_key: '',
        api_timeout_ms: 1000,
        servers: { [SERVER]: { hltv_addr: '127.0.0.1', hltv_port: 27020, rcon_password: 'pw' } },
    };

    const sync = new HltvSyncService(cfg);
    (sync as any).fetchStatus = () => {
        try { return Promise.resolve(proxy.status()); }
        catch (e) { return Promise.reject(e); }
    };

    const fired: FiredRecord[] = [];
    const buffer = new HltvDelayBuffer(sync, (item) => {
        fired.push({ id: item.event._hid, event: item.event, firedAt: Date.now() });
    });
    const unwire = wireStrandedRescue(sync, buffer);
    sync.start();
    buffer.start();

    const posts: PostRecord[] = [];
    let nextId = 1;
    let epoch = 0;

    const capture = (name: string, over: any = {}): EventToken => {
        const tick = over.tick ?? Math.floor(proxy.gameTime());
        const id = nextId++;
        return {
            id, name, tick,
            event: { event: name, tick, map: proxy.map, match_id: 'HARNESS', _hid: id, ...over },
            epoch,
            mapStartWall: proxy.mapStartWall,
            delaySeconds: proxy.delaySeconds,
            createdAtWall: Date.now(),
            isBoard: name === 'player_stats_summary' || name === 'half_end',
        };
    };

    // Mirrors ingest.ts's ordering for a POST: forced sample on ktp_match_start,
    // then onIngestEvent (boundary detection + basis snapshot), then enqueue.
    const deliver = (token: EventToken): void => {
        if (token.name === 'ktp_match_start') void sync.sample(SERVER, 'ktp_match_start');
        sync.onIngestEvent(SERVER, token.event);
        buffer.enqueue({ server: SERVER, matchId: 'HARNESS', event: token.event, enqueuedAt: Date.now() });
        posts.push({ token, arrivedAtWall: Date.now() });
    };

    return {
        sync, buffer, proxy, fired, posts,
        heartbeatMs: cfg.heartbeat_seconds * 1000,
        boardLagMs: cfg.board_release_lag_seconds * 1000,
        fallbackMs: cfg.fallback_delay_seconds * 1000,
        epoch: () => epoch,
        capture,
        deliver,
        post: (name, over = {}) => { const t = capture(name, over); deliver(t); return t; },
        changelevel: (map?: string) => { proxy.changelevel(map); epoch++; },
        unwire,
        stop: () => { unwire(); buffer.stop(); sync.stop(); },
    };
}

/** Flush the microtask queue so sample()'s promise chain settles. */
export async function flushMicrotasks(rounds = 8): Promise<void> {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/**
 * Advance faked time in 250ms slices, flushing microtasks between slices.
 * (Jest 28 has no advanceTimersByTimeAsync.) Coarse slicing only ever makes
 * releases observably LATER, never earlier — folded into invariant slack.
 */
export async function advance(seconds: number): Promise<void> {
    let remain = Math.round(seconds * 1000);
    while (remain > 0) {
        const step = Math.min(250, remain);
        jest.advanceTimersByTime(step);
        await flushMicrotasks();
        remain -= step;
    }
}

/** Run [atSeconds, action] pairs on the faked clock, then coast to endAtSeconds. */
export async function runTimeline(
    actions: Array<[number, () => void | Promise<void>]>,
    endAtSeconds: number,
): Promise<void> {
    const sorted = [...actions].sort((a, b) => a[0] - b[0]);
    let cur = 0;
    for (const [at, fn] of sorted) {
        await advance(at - cur);
        cur = at;
        await fn();
        await flushMicrotasks();
    }
    await advance(endAtSeconds - cur);
}

/**
 * Release-stream invariants — the contract of the whole subsystem, asserted
 * over whatever ordering a scenario produced:
 *
 *  1. Nothing lost — every delivered event eventually fires.
 *  2. Never early — an event never fires before the broadcast clock reaches
 *     its tick: firedAt >= mapStartWall + (tick + delay)·1000.
 *  3. Bounded lateness — firedAt <= max(trueBroadcast + boardLag?, arrival)
 *     + one heartbeat + slack. Catches both the 2-minute-late board AND a
 *     stuck-until-map-flip strand, for any ordering.
 *  4. Epoch ordering (on-time posts only) — old-level events fire before
 *     next-level events. Stalled posts are exempt: an event that ARRIVES
 *     after later events already fired cannot precede them.
 *  5. Tick order within an epoch (on-time, non-board) — the board's
 *     deliberate late-bias may reorder it past same-epoch neighbors, so
 *     boards are exempt from tick monotonicity (not from epoch ordering).
 */
export function checkInvariants(h: Harness, opts: { slackMs?: number; earlyEpsMs?: number } = {}): void {
    const slackMs = opts.slackMs ?? 4000;
    const earlyEpsMs = opts.earlyEpsMs ?? 300;
    const byId = new Map(h.fired.map((f, seq) => [f.id, { ...f, seq }]));

    for (const p of h.posts) {
        const f = byId.get(p.token.id);
        // 1. Nothing lost.
        if (!f) throw new Error(`event never fired: ${p.token.name} tick=${p.token.tick} (id ${p.token.id})`);

        const trueBroadcast = p.token.mapStartWall + (p.token.tick + p.token.delaySeconds) * 1000;
        const lagMs = p.token.isBoard ? h.boardLagMs : 0;

        // 2. Never early.
        if (f.firedAt < trueBroadcast - earlyEpsMs) {
            throw new Error(`fired EARLY: ${p.token.name} tick=${p.token.tick} fired ${((trueBroadcast - f.firedAt) / 1000).toFixed(2)}s before broadcast`);
        }
        // 3. Bounded lateness.
        const bound = Math.max(trueBroadcast + lagMs, p.arrivedAtWall) + h.heartbeatMs + slackMs;
        if (f.firedAt > bound) {
            throw new Error(`fired LATE: ${p.token.name} tick=${p.token.tick} fired ${((f.firedAt - trueBroadcast) / 1000).toFixed(2)}s after broadcast (bound ${((bound - trueBroadcast) / 1000).toFixed(2)}s)`);
        }
    }

    // 4 + 5. Ordering over on-time posts, in actual fire order.
    const onTime = h.posts.filter(p => p.arrivedAtWall - p.token.createdAtWall < 500);
    const inFireOrder = onTime
        .map(p => ({ p, f: byId.get(p.token.id)! }))
        .sort((a, b) => a.f.seq - b.f.seq);
    let lastEpoch = -1;
    const lastTickInEpoch = new Map<number, number>();
    for (const { p } of inFireOrder) {
        if (p.token.epoch < lastEpoch) {
            throw new Error(`epoch ordering violated: epoch-${p.token.epoch} ${p.token.name} tick=${p.token.tick} fired after an epoch-${lastEpoch} event`);
        }
        lastEpoch = Math.max(lastEpoch, p.token.epoch);
        if (!p.token.isBoard) {
            const prev = lastTickInEpoch.get(p.token.epoch) ?? -Infinity;
            if (p.token.tick < prev) {
                throw new Error(`tick ordering violated in epoch ${p.token.epoch}: ${p.token.name} tick=${p.token.tick} fired after tick=${prev}`);
            }
            lastTickInEpoch.set(p.token.epoch, p.token.tick);
        }
    }
}
