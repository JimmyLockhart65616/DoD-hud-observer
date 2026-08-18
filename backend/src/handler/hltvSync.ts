import dgram from 'dgram';
import http from 'http';
import { EventEmitter } from 'events';

// ─── HLTV broadcast clock state ────────────────────────────────────────────
//
// The GoldSrc HLTV proxy implements `delay` as a clock offset, not a packet
// queue: viewers are served the proxy's own `m_ClientWorldTime`. So once we know
// that serve point for an HLTV instance at sample wall-clock T0, we can convert
// any future event's `tick` (game-server seconds-since-map-load, injected by the
// plugin) into a wall-clock fire time:
//
//     fireAt = T0 + (event.tick - serveTime) × 1000ms
//
// `serveTime` is READ from the proxy where possible (`Spectator Time`, KTP-ReHLDS
// PR #3) and otherwise inferred as `activeTime - delay`, which is what this file
// did exclusively until that patch — see serveTimeOf().
//
// That's the wall-clock instant HLTV's broadcast clock will catch up to the
// event's game-time tick — i.e., when broadcast viewers see the corresponding
// frame. Steady-state jitter is ~50 ms (proxy updaterate-bound), so a single
// sample per match plus a slow heartbeat is enough for ±1s sync.
//
// Map changes / long pauses fire `Proxy::RunClocks: forcing client delay (1|2)`
// on HLTV and snap the broadcast clock forward by seconds. We re-sample on
// `ktp_match_start`, on detected map change (event.map / event.tick reset),
// and on the configurable heartbeat — recovery is eventual, which the user has
// accepted as fine for map-change boundaries.

export interface HltvServerConfig {
    hltv_addr: string;       // typically 127.0.0.1 since backend runs alongside HLTV instances
    hltv_port: number;       // 27020-27044 in the KTP fleet
    rcon_password: string;   // matches HLTV's `adminpassword` cvar
}

// Recording state from hltv-api 2.2's GET /hltv/<port>/state. Sourced by
// scanning the last 5 minutes of `journalctl -u hltv@<port>` for Start/Already/
// Completed/Length lines. Used here purely as observation — does NOT feed into
// broadcast clock math. Captured at every RCON sample so we can correlate with
// the open ~99s broadcast offset bug (see project_post_uaf_followups memory).
export interface RecordingState {
    recording: boolean;
    basename: string | null;
    process_running: boolean;
    last_event: { type: string; age_sec: number } | null;
    already_recording_warning: boolean;
    error?: string;
}

export interface HltvClock {
    server: string;            // game-server hostname (matches X-Server-Hostname)
    cfg: HltvServerConfig;
    delaySeconds: number;      // last `Delay <N>` from rcon status
    activeTime: number;        // last LIVE world clock (fractional when reported)
    serveTime: number;         // serve point at sampledAt — measured, else activeTime − delay
    serveTimeMeasured: boolean; // true when the proxy reported Spectator Time (observability only)
    sampledAt: number;         // Date.now() when the sample was taken
    map: string | null;        // last `Map "<name>.bsp"`
    serverName: string | null; // last `Server Name "<name>"` (for cross-check)
    online: boolean;           // false on RCON failure or HLTV-not-connected
    lastError: string | null;
    calibrationOffsetMs: number; // operator-set fine-tune; added to broadcastNow
    recordingState: RecordingState | null; // hltv-api /state observation, null if api_url unset or fetch failed
    recordingStateError: string | null;
}

// Snapshot of the broadcast clock captured just before a changelevel. The delay
// buffer projects the old-map tail's release times off this healthy pre-reset
// basis (broadcastNow inverted) instead of the post-reset live clock, which is
// re-anchored to the new map and can briefly report an inflated Delay. See
// HltvSyncService.tailBasis / HltvDelayBuffer.drainTail.
export interface ClockBasis {
    activeTime: number;
    serveTime: number;
    sampledAt: number;
    delaySeconds: number;
    calibrationOffsetMs: number;
}

/**
 * HLTV's broadcast clock at this moment, in the same units as event.tick
 * (seconds since map load on the game server).
 */
export function broadcastNow(c: HltvClock, now: number = Date.now()): number {
    const elapsedSinceSample = (now - c.sampledAt) / 1000;
    return c.serveTime + elapsedSinceSample + (c.calibrationOffsetMs / 1000);
}

// ─── GoldSrc UDP RCON client ────────────────────────────────────────────────
//
// HLTV speaks the same UDP RCON protocol as HLDS:
//   1. send  ÿÿÿÿchallenge rcon\n\0       → recv  ÿÿÿÿchallenge rcon <num>\n\0
//   2. send  ÿÿÿÿrcon <num> <pwd> <cmd>\n\0 → recv ÿÿÿÿl<byte><response>\0
//
// HLTV uses `adminpassword` as the RCON password. Verified against production
// instance 27020 during planning — `status` returns:
//
//   --- HLTV Status ---
//   Online HH:MM:SS, FPS N, Version N (Linux)
//   Local IP <addr>, Network In N, Out N, Loss N
//   Local Slots N, Spectators N (max N), Proxies N
//   Total Slots N, Spectators N (max N), Proxies N
//   Connected to Game Server <addr>, Delay <seconds>
//   Server Name "<name>"
//   Game Time MM:SS, Mod "<mod>", Map "<map>.bsp", Players N

const RCON_PREFIX = Buffer.from([0xff, 0xff, 0xff, 0xff]);

export interface RconStatus {
    delaySeconds: number;
    activeTime: number;          // live world clock; fractional when the proxy reports World Time
    serveTime?: number;          // measured m_ClientWorldTime, absent on proxies without the patch
    map: string | null;
    serverName: string | null;
}

// The serve point at sample time, in event-tick units.
//
// PREFER the proxy's measured m_ClientWorldTime. `activeTime - delaySeconds` is
// an INFERENCE: `delay` is the target RunClocks aims at, not a reading of where
// the clock sits, and RunClocks may sag toward delay+10 before its first
// corrective branch fires. Measured locally at delay+0.02..0.03 in steady state,
// so the inference is close — but it is only sound while the clock is behaving,
// and nothing in the inference itself can tell you when it isn't.
//
// Falls back to the inference on any proxy that doesn't report Spectator Time —
// which is every proxy until KTP-ReHLDS PR #3 ships. That path is byte-identical
// to the long-standing behaviour.
export function serveTimeOf(status: RconStatus): number {
    const measured = status.serveTime;
    if (measured === undefined || !Number.isFinite(measured)) {
        return status.activeTime - status.delaySeconds;
    }
    // Bound the measured value against the live clock before trusting it with
    // broadcast timing: the serve point trails live by ~delay and can never lead
    // it. Outside that envelope the status format has moved under us, and a
    // silently wrong serve point desyncs the entire overlay — degrade to the
    // inference rather than propagate garbage.
    const behind = status.activeTime - measured;
    if (behind < -1 || behind > status.delaySeconds + 30) {
        return status.activeTime - status.delaySeconds;
    }
    return measured;
}

// Parse an HLTV `status` reply body. Split out from the UDP round-trip so it is
// reachable from tests — the truncation and serve-point handling below decides
// broadcast alignment, and it used to be untestable behind socket I/O.
export function parseStatusText(text: string): RconStatus {
    if (text.includes('Bad rcon_password')) throw new Error('bad rcon password');
    if (text.includes('not registered')) throw new Error(`rcon command rejected: ${text.slice(0, 80)}`);

    const delayMatch = text.match(/Delay (\d+)/);
    const gameTimeMatch = text.match(/Game Time (\d+):(\d+)/);
    // Both added by KTP-ReHLDS PR #3; absent on every proxy predating it.
    const serveMatch = text.match(/Spectator Time (\d+(?:\.\d+)?)/);
    const worldMatch = text.match(/World Time (\d+(?:\.\d+)?)/);
    const mapMatch = text.match(/Map "([^"]+)"/);
    const serverNameMatch = text.match(/Server Name "([^"]+)"/);

    if (!delayMatch || !gameTimeMatch) {
        throw new Error(`status missing Delay/GameTime — HLTV may not be connected to game server: ${text.slice(0, 200).replace(/\n/g, ' | ')}`);
    }

    // `Game Time MM:SS` is TRUNCATED, so any clock derived from it runs 0-1s
    // low — one-sided, never high. The error also does not average out: the
    // heartbeat interval is fixed and the world clock advances 1:1 with wall
    // time, so every sample lands on the same sub-second phase and the loss
    // presents as a stable per-server CONSTANT rather than as jitter. That is
    // precisely what tempts you to paper over it with a hand-tuned offset.
    // Two local proxies, same binary, sampled together: 0.53s and 0.01s lost.
    const gameTimeSeconds = parseInt(gameTimeMatch[1], 10) * 60 + parseInt(gameTimeMatch[2], 10);
    const worldTime = worldMatch ? parseFloat(worldMatch[1]) : undefined;
    // Same clock at two precisions, so they must agree to within the truncation.
    // Divergence means the format moved under us — keep the field we have always
    // parsed.
    const activeTime = worldTime !== undefined && Math.abs(worldTime - gameTimeSeconds) <= 2
        ? worldTime
        : gameTimeSeconds;

    return {
        delaySeconds: parseInt(delayMatch[1], 10),
        activeTime,
        serveTime: serveMatch ? parseFloat(serveMatch[1]) : undefined,
        map: mapMatch?.[1].replace(/\.bsp$/, '') ?? null,
        serverName: serverNameMatch?.[1] ?? null,
    };
}

async function rconStatus(cfg: HltvServerConfig, timeoutMs: number): Promise<RconStatus> {
    const sock = dgram.createSocket('udp4');
    try {
        const challenge = await rconRoundTrip(sock, cfg, Buffer.concat([RCON_PREFIX, Buffer.from('challenge rcon\n\0')]), timeoutMs);
        const m = challenge.toString('binary').match(/challenge rcon (-?\d+)/);
        if (!m) throw new Error(`unexpected challenge response: ${challenge.toString('utf8').slice(0, 80)}`);
        const challengeNum = m[1];

        const cmd = `rcon ${challengeNum} ${cfg.rcon_password} status\n\0`;
        const reply = await rconRoundTrip(sock, cfg, Buffer.concat([RCON_PREFIX, Buffer.from(cmd)]), timeoutMs);

        // Strip 4-byte 0xff prefix, the 'l' marker, and one length byte; the rest
        // is text. That length byte is outputbuf[0] in Proxy::ExecuteRcon — the
        // uninitialized one KTP-ReHLDS PR #3 makes deterministic. Stripping a
        // fixed 6 is why that fix writes a space there rather than re-basing the
        // payload, which would shift this offset.
        return parseStatusText(reply.slice(6).toString('utf8'));
    } finally {
        sock.close();
    }
}

// ─── hltv-api /state client ─────────────────────────────────────────────────
//
// hltv-api 2.2 ships a GET /hltv/<port>/state endpoint that returns the
// recording state derived from journalctl. We poll it after each RCON sample
// to capture a parallel signal for diagnosing the broadcast offset bug. Pure
// observation — never affects broadcast clock math; failures are swallowed
// and surface as `recordingStateError` on the clock.
async function fetchRecordingState(
    apiUrl: string,
    apiAuthKey: string,
    port: number,
    timeoutMs: number,
): Promise<RecordingState> {
    const url = new URL(`/hltv/${port}/state`, apiUrl);
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: url.hostname,
                port: url.port || 80,
                path: url.pathname,
                method: 'GET',
                headers: { 'X-Auth-Key': apiAuthKey },
                timeout: timeoutMs,
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`hltv-api /state returned ${res.statusCode}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    } catch (e: any) {
                        reject(new Error(`hltv-api /state parse error: ${e.message}`));
                    }
                });
            },
        );
        req.on('timeout', () => { req.destroy(new Error(`hltv-api /state timeout after ${timeoutMs}ms`)); });
        req.on('error', reject);
        req.end();
    });
}

function rconRoundTrip(sock: dgram.Socket, cfg: HltvServerConfig, packet: Buffer, timeoutMs: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            sock.removeAllListeners('message');
            reject(new Error(`rcon timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        sock.once('message', (msg) => {
            clearTimeout(timer);
            resolve(msg);
        });
        sock.send(packet, cfg.hltv_port, cfg.hltv_addr, (err) => {
            if (err) {
                clearTimeout(timer);
                reject(err);
            }
        });
    });
}

// ─── HltvSyncService ────────────────────────────────────────────────────────
//
// Owns the per-server clock cache and sample lifecycle. Sampling is *triggered*
// (lazy init, heartbeat, match start, manual, push), never continuously polled.

export interface HltvSyncConfig {
    enabled: boolean;
    heartbeat_seconds: number;       // 0 disables the heartbeat
    fallback_delay_seconds: number;  // used when no successful sample exists yet
    // Extra late-bias (seconds) added to the release of BOARD events
    // (player_stats_summary / half_end) at a changelevel, so the halftime /
    // match-end stats board errs slightly late rather than early relative to the
    // experienced footage delay (the reported Delay underestimates it — RunClocks
    // sags the client clock toward delay+10). UX bias only; the base release is
    // the dynamic broadcast-clock projection. 0 = exact projection.
    board_release_lag_seconds: number;
    // How long to keep coasting the last good clock across transient RCON sample
    // failures before giving up to the fixed fallback delay. While coasting, the
    // clock stays online and frozen so broadcastNow() keeps advancing 1:1 — the
    // buffer never drops to fallback and there's no step when sampling resumes.
    coast_grace_seconds: number;
    rcon_timeout_ms: number;
    servers: Record<string, HltvServerConfig>;  // keyed on game-server hostname (matches X-Server-Hostname)
    // hltv-api integration (KTPInfrastructure scripts/hltv-api.py, v2.2+).
    // When api_url is non-empty, each successful RCON sample also fetches
    // /hltv/<port>/state and attaches it to the clock for diagnostics. Empty
    // disables the feature (e.g. local dev without hltv-api running).
    api_url: string;
    api_auth_key: string;
    api_timeout_ms: number;
}

// Same threshold as HltvDelayBuffer's tick-reset detection. Kept in sync as a
// local constant so this module stays self-contained — they describe the same
// game-server clock event from two angles (queue tail vs. last-seen-tick).
const TICK_RESET_THRESHOLD_S = 30;

// Old-epoch straggler classification (oldEpochTick): how long after a detected
// boundary a late-arriving old-level POST is still recognized, and how close
// its tick must sit to the old level's final tick. Both windows exist to
// reject the look-alike: a long warmup silence on the NEW map eventually
// produces a legitimate forward tick jump too, but its tick is far below the
// old level's tail (and typically outside the wall window).
const STRAGGLER_WALL_WINDOW_MS = 120_000;
const STRAGGLER_TICK_WINDOW_S = 120;

// When a good sample lands after a coast/gap, log a "resync step" if the fresh
// sample's broadcast clock disagrees with the coasted projection by more than
// this. Normal heartbeats agree to well under 1s; only a genuine HLTV clock snap
// (proxy "forcing client delay", or recovery after a long outage) trips it.
const RESYNC_STEP_THRESHOLD_S = 2;

function formatRecordingStateLog(state: RecordingState | null, err: string | null): string {
    if (err) return ` recording=err:${err}`;
    if (!state) return '';
    if (!state.process_running) return ' recording=process-down';
    if (!state.recording) return ' recording=idle';
    const evt = state.last_event ? `${state.last_event.type}@${state.last_event.age_sec}s` : 'no-events';
    return ` recording=${state.basename ?? '?'} (${evt})`;
}

export class HltvSyncService extends EventEmitter {
    private clocks = new Map<string, HltvClock>();
    private lazyInited = new Set<string>();
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private inflight = new Map<string, Promise<HltvClock | null>>();
    // Highest event.tick observed per server. After a confirmed tick reset
    // (changelevel / half-2 / OT) we drop this to the new low value so the
    // next legitimate event doesn't re-trigger the reset path.
    private highestEventTick = new Map<string, number>();
    // Broadcast clock as of the last NORMAL (non-boundary) ingest event, per
    // server. Promoted to resetBasis when a changelevel is detected. Pairing the
    // snapshot with event flow — instead of reading the live clock at reset
    // detection — matters because a heartbeat can land mid-changelevel and
    // re-anchor the live clock to the new map before the first new-map event
    // arrives; the last-event snapshot is guaranteed pre-boundary (no events
    // flow during the map reload).
    private lastEventClock = new Map<string, ClockBasis>();
    // Broadcast clock basis for the tail of the level that just ended (per
    // server), promoted from lastEventClock at changelevel detection. The delay
    // buffer projects the old-map tail's release times off this (tailBasis).
    private resetBasis = new Map<string, ClockBasis>();
    // When the last boundary was detected and where the old level's ticks
    // topped out — the reference frame for oldEpochTick's straggler check.
    private lastBoundary = new Map<string, { at: number; preResetHighWater: number }>();

    constructor(private cfg: HltvSyncConfig) { super(); }

    /**
     * Fetch hltv-api /state for the given port. Returns [state, error] —
     * exactly one is non-null. When api_url is empty (feature disabled), both
     * are null. Never throws; failures land in the error slot for diagnostics.
     */
    private async observeRecordingState(port: number): Promise<[RecordingState | null, string | null]> {
        if (!this.cfg.api_url) return [null, null];
        try {
            const state = await fetchRecordingState(this.cfg.api_url, this.cfg.api_auth_key, port, this.cfg.api_timeout_ms);
            return [state, null];
        } catch (err: any) {
            return [null, err.message];
        }
    }

    // Seam for tests: the real UDP RCON `status` fetch. Overridable (via the
    // usual `(svc as any).fetchStatus = …` pattern) so unit tests can drive
    // sample() success/failure deterministically without network I/O.
    protected fetchStatus(cfg: HltvServerConfig): Promise<RconStatus> {
        return rconStatus(cfg, this.cfg.rcon_timeout_ms);
    }

    isActive(server: string): boolean {
        return this.cfg.enabled && server in this.cfg.servers;
    }

    /** Returns the live broadcast offset for a server, or null if no sample yet. */
    getClock(server: string): HltvClock | null {
        return this.clocks.get(server) ?? null;
    }

    /**
     * Synchronous helper for the delay buffer hot path.
     *
     * Returns null when no clock exists yet OR when the last RCON sample
     * failed (online=false). A failed sample leaves a placeholder clock with
     * activeTime=0 + delaySeconds=fallback, so naive math would yield a
     * negative broadcast time and the buffer would never release any positive-
     * tick event. Returning null instead routes the buffer to its
     * fallback_delay_seconds path, which fires events after the fixed delay
     * elapses regardless of whether HLTV is reachable.
     */
    broadcastNow(server: string, now: number = Date.now()): number | null {
        const c = this.clocks.get(server);
        return c && c.online ? broadcastNow(c, now) : null;
    }

    /** Used by the buffer when no clock exists yet — applies fallback delay. */
    fallbackDelaySeconds(): number { return this.cfg.fallback_delay_seconds; }

    /** UX late-bias (seconds) for board events released across a changelevel. */
    boardReleaseLagSeconds(): number { return this.cfg.board_release_lag_seconds; }

    /**
     * Basis for projecting an old-level tail onto the wall clock: the boundary
     * snapshot promoted at changelevel detection, else the last-event snapshot.
     * The fallback covers rescues that fire BEFORE ingest-side boundary
     * detection — e.g. a heartbeat landing mid-changelevel re-anchors the clock
     * and strands the old tail while no new-map event has arrived to promote
     * the basis yet. Both snapshots are anchored to each event's game-time tick
     * (immune to POST arrival jitter) and carry the pre-boundary delay (immune
     * to the inflated Delay a resample can read while the proxy is
     * mid-changelevel). Null when the server has never sampled during events.
     */
    tailBasis(server: string): ClockBasis | null {
        return this.resetBasis.get(server) ?? this.lastEventClock.get(server) ?? null;
    }

    // Promote the last-event clock snapshot to the reset basis at a detected
    // changelevel. The snapshot predates the boundary by construction (it was
    // taken while old-map events were still flowing), so it stays correct even
    // when a heartbeat re-anchored the live clock mid-changelevel.
    private promoteEventBasis(server: string): void {
        const snap = this.lastEventClock.get(server);
        if (snap) this.resetBasis.set(server, snap);
    }

    /**
     * True when a tick belongs to the level that ended at the last detected
     * boundary — a late old-half POST (curl stall across the changelevel)
     * arriving after new-level events already lowered the tick clock.
     *
     * Left in the main flow, such a straggler poisons two things: it becomes
     * the queue's highest-tick tail, so the next fresh event mis-triggers the
     * enqueue-time reset and the whole queue drains against the WRONG epoch's
     * basis (the straggler would then be held until the new broadcast clock
     * climbed to its old tick — end of half 2); and it would raise the tick
     * high-water mark, firing a spurious tick_reset on the next fresh event.
     * The buffer instead routes classified ticks straight to the drain under
     * the old-epoch basis, and onIngestEvent skips bookkeeping for them.
     *
     * Classification requires all three, to reject the look-alike (a long
     * warmup silence on the new level also produces a forward tick jump, but
     * its tick sits far below the old level's tail):
     *   1. a boundary was detected within STRAGGLER_WALL_WINDOW_MS;
     *   2. the tick jumps ahead of the current level's high-water mark by more
     *      than TICK_RESET_THRESHOLD_S;
     *   3. the tick lands within STRAGGLER_TICK_WINDOW_S of the old level's
     *      final tick.
     */
    oldEpochTick(server: string, tick: number): boolean {
        const b = this.lastBoundary.get(server);
        if (!b || Date.now() - b.at > STRAGGLER_WALL_WINDOW_MS) return false;
        const highWater = this.highestEventTick.get(server);
        if (highWater !== undefined && tick - highWater <= TICK_RESET_THRESHOLD_S) return false;
        // A tick is only UNAMBIGUOUSLY old-epoch when the current level's clock
        // cannot have reached it yet. When the new level's game time has already
        // climbed into the old tail's range (short halves / long quiet spells),
        // don't classify — ambiguous events stay in the main flow, where the
        // strand margin and heartbeat rescue still bound their lateness.
        const c = this.clocks.get(server);
        if (c && c.online) {
            const currentGameTime = c.activeTime + (Date.now() - c.sampledAt) / 1000;
            if (tick <= currentGameTime + TICK_RESET_THRESHOLD_S) return false;
        }
        return Math.abs(tick - b.preResetHighWater) <= STRAGGLER_TICK_WINDOW_S;
    }

    /**
     * Current HLTV broadcast delay (cvar) for a server, or null if no clock
     * yet. Returned even when online=false: at a changelevel the clock is
     * marked offline *before* the buffer drains the old-map tail, but
     * delaySeconds is preserved across a failed sample (the `...prev` spread in
     * sample()'s catch), so it still holds the delay that applied to the
     * buffered tail — exactly what the drain must release on. The buffer uses
     * this to release old-map events on their broadcast delay across the
     * boundary instead of flushing them instantly.
     */
    delaySeconds(server: string): number | null {
        const c = this.clocks.get(server);
        return c ? c.delaySeconds : null;
    }

    setCalibrationOffsetMs(server: string, offsetMs: number): void {
        const c = this.clocks.get(server);
        if (c) {
            c.calibrationOffsetMs = offsetMs;
            this.emit('clock', c);
        }
    }

    /** Lazy-init: first event from a server triggers the first sample. */
    onIngestEvent(server: string, event: any): void {
        if (!this.isActive(server)) return;
        if (!this.lazyInited.has(server)) {
            this.lazyInited.add(server);
            if (typeof event.tick === 'number') {
                this.highestEventTick.set(server, event.tick);
            }
            void this.sample(server, 'lazy_init');
            return;
        }
        // Map change / tick reset detection — force a fresh sample so the
        // buffer doesn't fire post-changelevel events with stale clock math.
        const c = this.clocks.get(server);
        if (c && event.map && c.map && event.map !== c.map) {
            const preResetHighWater = this.highestEventTick.get(server);
            if (preResetHighWater !== undefined) {
                this.lastBoundary.set(server, { at: Date.now(), preResetHighWater });
            }
            this.highestEventTick.delete(server);
            this.promoteEventBasis(server);
            void this.sample(server, 'map_change');
        } else if (typeof event.tick === 'number') {
            // A late old-level POST (curl stall across the changelevel) must not
            // touch the high-water mark or the clock snapshot — see oldEpochTick.
            if (this.oldEpochTick(server, event.tick)) return;
            const prev = this.highestEventTick.get(server);
            if (prev !== undefined && prev - event.tick > TICK_RESET_THRESHOLD_S) {
                // Same map, fresh map load (half-2 changelevel / OT). Cached
                // activeTime is from the *previous* level instance — naive
                // broadcastNow() would now run minutes ahead of reality and
                // the buffer would fire post-reset events instantly. Mark the
                // clock offline so the buffer takes the fallback-delay path
                // until the resample lands, and reset the tick high-water mark
                // so we don't re-trigger on the next event. Promote the
                // last-event clock snapshot to the reset basis first so the
                // buffer can project the old-map tail off the pre-boundary
                // clock (see HltvDelayBuffer.drainTail).
                this.lastBoundary.set(server, { at: Date.now(), preResetHighWater: prev });
                this.promoteEventBasis(server);
                if (c) c.online = false;
                this.highestEventTick.set(server, event.tick);
                void this.sample(server, 'tick_reset');
                return;
            }
            if (prev === undefined || event.tick > prev) {
                this.highestEventTick.set(server, event.tick);
            }
        }
        // Normal (non-boundary) TICK'D event: pair the current clock with the
        // event flow. Coasting clocks (online, frozen params) still project
        // linearly, so they're valid snapshots; post-reset offline clocks are
        // not. Tick-less events are excluded — they can't witness which level
        // instance the clock belongs to, and pairing one with a just-re-anchored
        // clock would poison the tailBasis fallback for a still-queued old tail.
        if (c && c.online && typeof event.tick === 'number') {
            this.lastEventClock.set(server, {
                activeTime: c.activeTime,
                serveTime: c.serveTime,
                sampledAt: c.sampledAt,
                delaySeconds: c.delaySeconds,
                calibrationOffsetMs: c.calibrationOffsetMs,
            });
        }
    }

    /** Force a sample now. Used at ktp_match_start, manual API, drift push. */
    async sample(server: string, reason: string): Promise<HltvClock | null> {
        if (!this.isActive(server)) return null;

        // Coalesce concurrent samples for the same server.
        const inflight = this.inflight.get(server);
        if (inflight) return inflight;

        const cfg = this.cfg.servers[server];
        const promise = (async (): Promise<HltvClock | null> => {
            const sampledAt = Date.now();
            try {
                const status = await this.fetchStatus(cfg);
                const [recordingState, recordingStateError] = await this.observeRecordingState(cfg.hltv_port);
                const prev = this.clocks.get(server);
                const clock: HltvClock = {
                    server,
                    cfg,
                    delaySeconds: status.delaySeconds,
                    activeTime: status.activeTime,
                    serveTime: serveTimeOf(status),
                    serveTimeMeasured: status.serveTime !== undefined,
                    sampledAt,
                    map: status.map,
                    serverName: status.serverName,
                    online: true,
                    lastError: null,
                    calibrationOffsetMs: prev?.calibrationOffsetMs ?? 0,
                    recordingState,
                    recordingStateError,
                };
                // Reconcile: if the previous clock was live (healthy or coasting),
                // compare its projection at this instant to the fresh sample. We
                // always adopt the fresh sample (ground truth), but a large gap means
                // HLTV's clock moved while we weren't watching — log it so the step is
                // observable instead of a silent jump in the overlay.
                if (prev && prev.online) {
                    const stepSec = broadcastNow(clock, sampledAt) - broadcastNow(prev, sampledAt);
                    if (Math.abs(stepSec) > RESYNC_STEP_THRESHOLD_S) {
                        console.warn(`[hltv-sync] ${server} resync step ${stepSec.toFixed(1)}s on ${reason} (HLTV clock moved during coast/gap; sample age was ${Math.round((sampledAt - prev.sampledAt) / 1000)}s)`);
                    }
                }
                this.clocks.set(server, clock);
                console.log(`[hltv-sync] ${server} sample (${reason}): delay=${clock.delaySeconds}s gameTime=${clock.activeTime.toFixed(2)}s serve=${clock.serveTime.toFixed(2)}s${clock.serveTimeMeasured ? '' : '(inferred)'} map=${clock.map}${formatRecordingStateLog(recordingState, recordingStateError)}`);
                if (recordingState?.already_recording_warning) {
                    console.warn(`[hltv-sync] ${server} hltv-api reports already_recording_warning — half-2 record command likely refused (basename=${recordingState.basename ?? 'unknown'})`);
                }
                this.emit('clock', clock);
                return clock;
            } catch (err: any) {
                const prev = this.clocks.get(server);
                // Coast across a TRANSIENT failure during steady play: keep the last
                // good clock online and frozen. broadcastNow() advances 1:1 off the
                // preserved (activeTime, sampledAt), so the buffer keeps releasing
                // normally and there's no step when sampling resumes. Excluded:
                //  - boundaries: tick_reset already set online=false above, and
                //    map_change's activeTime is now for the wrong map (must fall to
                //    fallback), so neither coasts.
                //  - stale: once we've been failing longer than coast_grace_seconds
                //    (measured from the last GOOD sample, which stays frozen across
                //    coasts), give up to fallback as before.
                const ageMs = sampledAt - (prev?.sampledAt ?? 0);
                const canCoast = !!prev && prev.online && reason !== 'map_change'
                    && ageMs <= this.cfg.coast_grace_seconds * 1000;
                let clock: HltvClock;
                if (canCoast) {
                    clock = { ...prev!, lastError: err.message }; // online stays true; clock frozen → coasts
                    console.warn(`[hltv-sync] ${server} sample failed (${reason}): ${err.message} — coasting (last good sample ${Math.round(ageMs / 1000)}s ago)`);
                } else {
                    clock = prev
                        ? { ...prev, online: false, lastError: err.message }
                        : {
                            server, cfg,
                            delaySeconds: this.cfg.fallback_delay_seconds,
                            activeTime: 0,
                            serveTime: -this.cfg.fallback_delay_seconds,
                            serveTimeMeasured: false,
                            sampledAt,
                            map: null,
                            serverName: null,
                            online: false,
                            lastError: err.message,
                            calibrationOffsetMs: 0,
                            recordingState: null,
                            recordingStateError: null,
                        };
                    console.warn(`[hltv-sync] ${server} sample failed (${reason}): ${err.message}`);
                }
                this.clocks.set(server, clock);
                this.emit('clock', clock);
                return clock;
            } finally {
                this.inflight.delete(server);
            }
        })();
        this.inflight.set(server, promise);
        return promise;
    }

    start(): void {
        if (!this.cfg.enabled) return;
        if (this.cfg.heartbeat_seconds > 0) {
            this.heartbeatTimer = setInterval(() => {
                for (const server of Object.keys(this.cfg.servers)) {
                    if (this.lazyInited.has(server)) void this.sample(server, 'heartbeat');
                }
            }, this.cfg.heartbeat_seconds * 1000);
        }
        console.log(`[hltv-sync] enabled (heartbeat=${this.cfg.heartbeat_seconds}s, fallback=${this.cfg.fallback_delay_seconds}s, ${Object.keys(this.cfg.servers).length} servers)`);
    }

    stop(): void {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }

    /** Snapshot for /api/hltv/status. */
    getStatus(): any[] {
        return Object.keys(this.cfg.servers).map(server => {
            const c = this.clocks.get(server);
            return c ? {
                server,
                hltvHost: `${c.cfg.hltv_addr}:${c.cfg.hltv_port}`,
                delaySeconds: c.delaySeconds,
                activeTime: c.activeTime,
                serveTime: c.serveTime,
                serveTimeMeasured: c.serveTimeMeasured,
                map: c.map,
                serverName: c.serverName,
                sampledAt: c.sampledAt,
                sampleAgeMs: Date.now() - c.sampledAt,
                broadcastNow: broadcastNow(c),
                lastEventTick: this.highestEventTick.get(server) ?? null,
                coastGraceSeconds: this.cfg.coast_grace_seconds,
                online: c.online,
                lastError: c.lastError,
                calibrationOffsetMs: c.calibrationOffsetMs,
                recordingState: c.recordingState,
                recordingStateError: c.recordingStateError,
            } : {
                server,
                hltvHost: `${this.cfg.servers[server].hltv_addr}:${this.cfg.servers[server].hltv_port}`,
                online: false,
                lastError: 'no sample yet',
            };
        });
    }
}
