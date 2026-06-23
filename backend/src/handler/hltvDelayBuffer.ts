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

// An old-map event evicted from the main queue at a changelevel, stamped with
// the absolute wall-clock instant it should fire (enqueuedAt + broadcast delay).
interface DrainItem extends BufferedEvent {
    releaseAt: number;
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
    // Old-map tail evicted at a changelevel, released on a wall-clock delay so
    // the broadcast delay is PRESERVED across the boundary (see drainTail).
    // Separate from the main queue because old (high-tick) and new (low-tick)
    // events can't share one tick-sorted queue under one broadcast clock.
    private draining = new Map<string, DrainItem[]>();
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

        // Tick reset (mid-match changelevel: half-2 / OT, or next map at match
        // end). Old-map events queued at high ticks would never reach the new
        // (low) broadcast clock and would otherwise sit forever. Move them to
        // the wall-clock drain queue so they still play out — but on their
        // ORIGINAL broadcast delay, not instantly. Firing them instantly here
        // collapses the HLTV delay exactly at boundaries: the broadcast hasn't
        // reached the end of the old map yet (it's ~delay seconds behind), so
        // an instant flush snaps the overlay ~delay seconds ahead of the feed
        // (cards vanish early at match end; the halftime board flashes before
        // the broadcast reaches halftime).
        if (q.length > 0) {
            const tailTick = numericTick(q[q.length - 1].event);
            if (tailTick - tick > TICK_RESET_THRESHOLD_S) {
                this.drainTail(item.server, q);
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

    // Move old-map events into the wall-clock drain queue, each stamped with
    // releaseAt = enqueuedAt + broadcast delay. enqueuedAt ≈ the live instant
    // the event occurred, so this reproduces the ~delay-second lag the event
    // already had — preserving broadcast alignment across the changelevel.
    // Uses the old clock's delaySeconds (preserved across the offline flip at
    // reset) and falls back to the configured fallback delay.
    private drainTail(server: string, items: BufferedEvent[]): void {
        if (!items.length) return;
        const delayMs = (this.sync.delaySeconds(server) ?? this.sync.fallbackDelaySeconds()) * 1000;
        let d = this.draining.get(server);
        if (!d) { d = []; this.draining.set(server, d); }
        for (const it of items) d.push({ ...it, releaseAt: it.enqueuedAt + delayMs });
        // Keep FIFO by release time (defensive against back-to-back resets,
        // e.g. half-2 → OT, stacking two tails).
        d.sort((a, b) => a.releaseAt - b.releaseAt);
    }

    queueDepth(server: string): number {
        return (this.queues.get(server)?.length ?? 0) + (this.draining.get(server)?.length ?? 0);
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
     * Moves events whose `tick` exceeds the new sample's `activeTime` — i.e.,
     * events from the *previous* map whose tick will never be reached on the
     * new clock — into the wall-clock drain queue. Without this they'd sit
     * forever, since broadcastNow resets near 0 at map change. Called from the
     * clock listener in app.ts when a fresh sample arrives.
     *
     * Like the enqueue-time reset, these release on their broadcast delay (not
     * instantly), so the boundary stays delay-aligned. Idempotent with the
     * enqueue drain: if the tail was already moved, this finds nothing.
     *
     * Events whose tick is still ≤ activeTime are left in the queue; the
     * normal driver tick fires them on schedule under the new clock.
     */
    releaseStrandedEvents(server: string, activeTime: number): void {
        const q = this.queues.get(server);
        if (!q || !q.length) return;
        const stranded: BufferedEvent[] = [];
        let i = 0;
        while (i < q.length) {
            if (numericTick(q[i].event) > activeTime) {
                stranded.push(q[i]);
                q.splice(i, 1);
            } else {
                i++;
            }
        }
        this.drainTail(server, stranded);
    }

    private tick(): void {
        const now = Date.now();

        // 1) Old-map tail — release on absolute wall-clock releaseAt, in FIFO
        // order. Uses enqueuedAt-derived times only (never a live clock), so
        // there's no stall path.
        for (const [server, d] of this.draining) {
            while (d.length && now >= d[0].releaseAt) this.onFire(d.shift()!);
            if (!d.length) this.draining.delete(server);
        }

        // 2) New-map / steady-state — held until this server's drain is empty
        // so the old-map tail always emits before new-map events (a fresh
        // low-tick event satisfies tick<=broadcast quickly and would otherwise
        // overtake the still-draining old tail). The seam is continuous: the
        // tail's last releaseAt ≈ reset + delay, and the new clock catches its
        // early ticks at ≈ the same instant.
        for (const [server, q] of this.queues) {
            if (!q.length || this.draining.has(server)) continue;
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
