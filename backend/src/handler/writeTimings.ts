/**
 * Timings for the recorder's synchronous disk appends, exposed on /metrics.
 *
 * Every append runs on the event loop, between ingest POSTs and socket
 * fan-out, so a slow disk shows up as broadcast latency for every server at
 * once. events.jsonl is a few rows a second per server. Recording the 4 Hz
 * player_state stream adds about 4 more per server, roughly 1.5 KB each, so
 * the cost is measured here before and after it is switched on rather than
 * assumed.
 */
export type WriteStream = 'events' | 'player_state';

const RECENT_SAMPLES = 1000;

interface StreamStats {
    count: number;
    bytes: number;
    errors: number;
    totalMs: number;
    maxMs: number;
    recent: number[];   // ring of the last RECENT_SAMPLES durations, ms
    next: number;
}

export interface WriteStreamSnapshot {
    count: number;
    bytes: number;
    errors: number;
    total_ms: number;
    max_ms: number;
    p50_ms: number | null;
    p99_ms: number | null;
}

export class WriteTimings {
    private streams = new Map<WriteStream, StreamStats>();

    /** Run `write`, timing it against `stream`. Rethrows what it throws. */
    time<T>(stream: WriteStream, bytes: number, write: () => T): T {
        const t0 = process.hrtime.bigint();
        let ok = false;
        try {
            const out = write();
            ok = true;
            return out;
        } finally {
            this.record(stream, bytes, Number(process.hrtime.bigint() - t0) / 1e6, ok);
        }
    }

    record(stream: WriteStream, bytes: number, ms: number, ok = true): void {
        let s = this.streams.get(stream);
        if (!s) {
            s = { count: 0, bytes: 0, errors: 0, totalMs: 0, maxMs: 0, recent: [], next: 0 };
            this.streams.set(stream, s);
        }
        if (!ok) { s.errors++; return; }
        s.count++;
        s.bytes += bytes;
        s.totalMs += ms;
        if (ms > s.maxMs) s.maxMs = ms;
        if (s.recent.length < RECENT_SAMPLES) s.recent.push(ms);
        else s.recent[s.next] = ms;
        s.next = (s.next + 1) % RECENT_SAMPLES;
    }

    snapshot(): Partial<Record<WriteStream, WriteStreamSnapshot>> {
        const out: Partial<Record<WriteStream, WriteStreamSnapshot>> = {};
        for (const [name, s] of this.streams) {
            const sorted = [...s.recent].sort((a, b) => a - b);
            const pct = (p: number) => (sorted.length
                ? round3(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))])
                : null);
            out[name] = {
                count: s.count,
                bytes: s.bytes,
                errors: s.errors,
                total_ms: round3(s.totalMs),
                max_ms: round3(s.maxMs),
                p50_ms: pct(0.5),
                p99_ms: pct(0.99),
            };
        }
        return out;
    }
}

function round3(n: number): number {
    return Math.round(n * 1000) / 1000;
}
