import dgram from 'dgram';
import http from 'http';
import { EventEmitter } from 'events';

// ─── HLTV broadcast clock state ────────────────────────────────────────────
//
// The GoldSrc HLTV proxy implements `delay` as a clock offset, not a packet
// queue: viewers see `m_World->GetTime() - delay`. So once we know `(activeTime,
// delay)` for an HLTV instance at sample wall-clock T0, we can convert any
// future event's `tick` (game-server seconds-since-map-load, injected by the
// plugin) into a wall-clock fire time:
//
//     fireAt = T0 + (event.tick + delay - activeTime) × 1000ms
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
    activeTime: number;        // last `Game Time MM:SS` converted to seconds
    sampledAt: number;         // Date.now() when the sample was taken
    map: string | null;        // last `Map "<name>.bsp"`
    serverName: string | null; // last `Server Name "<name>"` (for cross-check)
    online: boolean;           // false on RCON failure or HLTV-not-connected
    lastError: string | null;
    calibrationOffsetMs: number; // operator-set fine-tune; added to broadcastNow
    recordingState: RecordingState | null; // hltv-api /state observation, null if api_url unset or fetch failed
    recordingStateError: string | null;
}

/**
 * HLTV's broadcast clock at this moment, in the same units as event.tick
 * (seconds since map load on the game server).
 */
export function broadcastNow(c: HltvClock, now: number = Date.now()): number {
    const elapsedSinceSample = (now - c.sampledAt) / 1000;
    return c.activeTime + elapsedSinceSample - c.delaySeconds + (c.calibrationOffsetMs / 1000);
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

interface RconStatus {
    delaySeconds: number;
    activeTime: number;
    map: string | null;
    serverName: string | null;
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

        // Strip 4-byte 0xff prefix, the 'l' marker, and one length byte; the rest is text.
        const text = reply.slice(6).toString('utf8');
        if (text.includes('Bad rcon_password')) throw new Error('bad rcon password');
        if (text.includes('not registered')) throw new Error(`rcon command rejected: ${text.slice(0, 80)}`);

        const delayMatch = text.match(/Delay (\d+)/);
        const gameTimeMatch = text.match(/Game Time (\d+):(\d+)/);
        const mapMatch = text.match(/Map "([^"]+)"/);
        const serverNameMatch = text.match(/Server Name "([^"]+)"/);

        if (!delayMatch || !gameTimeMatch) {
            throw new Error(`status missing Delay/GameTime — HLTV may not be connected to game server: ${text.slice(0, 200).replace(/\n/g, ' | ')}`);
        }

        return {
            delaySeconds: parseInt(delayMatch[1], 10),
            activeTime: parseInt(gameTimeMatch[1], 10) * 60 + parseInt(gameTimeMatch[2], 10),
            map: mapMatch?.[1].replace(/\.bsp$/, '') ?? null,
            serverName: serverNameMatch?.[1] ?? null,
        };
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
            this.highestEventTick.delete(server);
            void this.sample(server, 'map_change');
        } else if (typeof event.tick === 'number') {
            const prev = this.highestEventTick.get(server);
            if (prev !== undefined && prev - event.tick > TICK_RESET_THRESHOLD_S) {
                // Same map, fresh map load (half-2 changelevel / OT). Cached
                // activeTime is from the *previous* level instance — naive
                // broadcastNow() would now run minutes ahead of reality and
                // the buffer would fire post-reset events instantly. Mark the
                // clock offline so the buffer takes the fallback-delay path
                // until the resample lands, and reset the tick high-water mark
                // so we don't re-trigger on the next event.
                if (c) c.online = false;
                this.highestEventTick.set(server, event.tick);
                void this.sample(server, 'tick_reset');
                return;
            }
            if (prev === undefined || event.tick > prev) {
                this.highestEventTick.set(server, event.tick);
            }
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
                const status = await rconStatus(cfg, this.cfg.rcon_timeout_ms);
                const [recordingState, recordingStateError] = await this.observeRecordingState(cfg.hltv_port);
                const prev = this.clocks.get(server);
                const clock: HltvClock = {
                    server,
                    cfg,
                    delaySeconds: status.delaySeconds,
                    activeTime: status.activeTime,
                    sampledAt,
                    map: status.map,
                    serverName: status.serverName,
                    online: true,
                    lastError: null,
                    calibrationOffsetMs: prev?.calibrationOffsetMs ?? 0,
                    recordingState,
                    recordingStateError,
                };
                this.clocks.set(server, clock);
                console.log(`[hltv-sync] ${server} sample (${reason}): delay=${clock.delaySeconds}s gameTime=${clock.activeTime}s map=${clock.map}${formatRecordingStateLog(recordingState, recordingStateError)}`);
                if (recordingState?.already_recording_warning) {
                    console.warn(`[hltv-sync] ${server} hltv-api reports already_recording_warning — half-2 record command likely refused (basename=${recordingState.basename ?? 'unknown'})`);
                }
                this.emit('clock', clock);
                return clock;
            } catch (err: any) {
                const prev = this.clocks.get(server);
                const clock: HltvClock = prev
                    ? { ...prev, online: false, lastError: err.message }
                    : {
                        server, cfg,
                        delaySeconds: this.cfg.fallback_delay_seconds,
                        activeTime: 0,
                        sampledAt,
                        map: null,
                        serverName: null,
                        online: false,
                        lastError: err.message,
                        calibrationOffsetMs: 0,
                        recordingState: null,
                        recordingStateError: null,
                    };
                this.clocks.set(server, clock);
                console.warn(`[hltv-sync] ${server} sample failed (${reason}): ${err.message}`);
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
                map: c.map,
                serverName: c.serverName,
                sampledAt: c.sampledAt,
                sampleAgeMs: Date.now() - c.sampledAt,
                broadcastNow: broadcastNow(c),
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
