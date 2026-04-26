import { HltvSyncService } from './hltvSync';

// ─── HltvDelayBuffer ────────────────────────────────────────────────────────
//
// Per-server in-memory reorder queue, keyed on the event's `tick` field
// (game-server seconds-since-map-load, injected by the plugin via
// post_event() → do_send_json()). An event is released to the `onFire`
// callback when the paired HLTV's broadcast clock catches up to its tick —
// i.e., when broadcast viewers will see the corresponding game frame.
//
// This buffer only sits in front of socket emission. MatchRecorder writes to
// disk synchronously in ingest.ts before enqueue, so events.jsonl is always
// the authoritative real-time record (replays read from there and don't
// touch this buffer).
//
// Invariant: replays do NOT go through this buffer. The replay path loads
// from disk via recorder.getEvents() and runs entirely client-side.

export interface BufferedEvent {
    server: string;
    matchId?: string;
    event: any;        // raw event with .tick set by plugin
    enqueuedAt: number;
}

export type FireCallback = (item: BufferedEvent) => void;

const DRIVER_TICK_MS = 50; // matches the GoldSrc HLTV proxy updaterate floor

// Detect a game-server tick reset (changelevel for half-2 / OT) by looking for
// an incoming event whose tick is at least this far below the queue tail. The
// half-1 tail tick is in the high hundreds-to-thousands; half-2 starts at
// ~1-90s. 30s is comfortably above natural out-of-order arrival jitter.
const TICK_RESET_THRESHOLD_S = 30;

export class HltvDelayBuffer {
    private queues = new Map<string, BufferedEvent[]>();
    private driver: NodeJS.Timeout | null = null;

    // onFire is required at construction so the buffer can't be assembled in
    // a half-wired state (an earlier refactor shipped with the setter never
    // called and every released event silently vanished into a no-op).
    constructor(private sync: HltvSyncService, private onFire: FireCallback) {}

    /** True if the buffer is configured to delay events for this server. */
    isActive(server: string): boolean { return this.sync.isActive(server); }

    enqueue(item: BufferedEvent): void {
        let q = this.queues.get(item.server);
        if (!q) { q = []; this.queues.set(item.server, q); }

        const tick = numericTick(item.event);

        // Tick reset (mid-match changelevel: half-2 / OT). Old-half events
        // queued at high ticks would never reach the new (low) broadcast clock
        // and would otherwise sit forever, while the queue head also wouldn't
        // re-sort to put the new low-tick event first under stale-clock math.
        // Drain the queue immediately so the kill feed / captures from end of
        // previous half still surface — they're already past on HLTV's side.
        if (q.length > 0) {
            const tailTick = numericTick(q[q.length - 1].event);
            if (tailTick - tick > TICK_RESET_THRESHOLD_S) {
                for (const stranded of q) this.onFire(stranded);
                q.length = 0;
            }
        }

        // Events arrive ~ordered by tick from the plugin, so almost every
        // append goes at the end. Linear-scan insertion is fine at the
        // realistic event rate (~10-50 events/sec/server).
        let i = q.length;
        while (i > 0 && numericTick(q[i - 1].event) > tick) i--;
        q.splice(i, 0, item);
    }

    queueDepth(server: string): number {
        return this.queues.get(server)?.length ?? 0;
    }

    start(): void {
        if (this.driver) return;
        this.driver = setInterval(() => this.tick(), DRIVER_TICK_MS);
    }

    stop(): void {
        if (this.driver) clearInterval(this.driver);
        this.driver = null;
    }

    /**
     * Releases events whose `tick` exceeds the new sample's `activeTime` —
     * i.e., events from the *previous* map whose tick will never be reached
     * on the new clock. Without this they'd sit forever, since broadcastNow
     * resets near 0 at map change. Called from the clock listener in app.ts
     * when a fresh sample arrives.
     *
     * Events whose tick is still ≤ activeTime are left in the queue; the
     * normal driver tick will fire them on schedule under the new clock.
     */
    releaseStrandedEvents(server: string, activeTime: number): void {
        const q = this.queues.get(server);
        if (!q) return;
        let i = 0;
        while (i < q.length) {
            if (numericTick(q[i].event) > activeTime) {
                this.onFire(q[i]);
                q.splice(i, 1);
            } else {
                i++;
            }
        }
    }

    private tick(): void {
        const now = Date.now();
        for (const [server, q] of this.queues) {
            if (!q.length) continue;
            const broadcast = this.sync.broadcastNow(server, now);
            // No clock yet (first sample still in flight, or last sample failed):
            // hold events until the fallback delay elapses. Without this, events
            // would fire immediately on a server that's configured but never
            // sampled successfully — defeating the purpose of the buffer.
            if (broadcast === null) {
                const fallback = this.sync.fallbackDelaySeconds() * 1000;
                while (q.length && (now - q[0].enqueuedAt) >= fallback) {
                    this.onFire(q.shift()!);
                }
                continue;
            }
            while (q.length && numericTick(q[0].event) <= broadcast) {
                this.onFire(q.shift()!);
            }
        }
    }
}

function numericTick(event: any): number {
    const t = event?.tick;
    return typeof t === 'number' ? t : 0;
}
