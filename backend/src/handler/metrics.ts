/**
 * MetricsCollector
 *
 * Tracks events-per-second (EPS) and latency, broken down by source server.
 * Exposed via GET /metrics.
 */
export class MetricsCollector {
    private counts: Map<string, number> = new Map();       // source → total count
    private windowCounts: Map<string, number> = new Map(); // source → count in current window
    private windowStart: number = Date.now();
    private windowMs: number = 10_000; // 10-second rolling window
    private latencies: Map<string, number[]> = new Map();  // source → recent latencies (ms)
    private lastSeen: Map<string, number> = new Map();     // source → unix ms of last event

    recordEvent(source: string): void {
        this.counts.set(source, (this.counts.get(source) ?? 0) + 1);
        this.windowCounts.set(source, (this.windowCounts.get(source) ?? 0) + 1);
        this.lastSeen.set(source, Date.now());
    }

    /**
     * Returns known servers with their last-seen time and event counts.
     */
    getServers(): ServerInfo[] {
        const servers: ServerInfo[] = [];
        for (const [source, count] of this.counts) {
            servers.push({
                hostname: source,
                total_events: count,
                last_seen: this.lastSeen.get(source) ?? 0,
                online: (Date.now() - (this.lastSeen.get(source) ?? 0)) < 60_000,
            });
        }
        return servers;
    }

    recordLatency(source: string, latencyMs: number): void {
        if (!this.latencies.has(source)) this.latencies.set(source, []);
        const arr = this.latencies.get(source)!;
        arr.push(latencyMs);
        // Keep last 100 samples per source
        if (arr.length > 100) arr.shift();
    }

    /**
     * Returns a snapshot for the /metrics endpoint.
     */
    getSnapshot(): MetricsSnapshot {
        const now = Date.now();
        const elapsed = (now - this.windowStart) / 1000;

        const perSource: Record<string, SourceMetrics> = {};
        let totalCount = 0;
        let windowTotal = 0;

        for (const [source, count] of this.counts) {
            const wc = this.windowCounts.get(source) ?? 0;
            const lats = this.latencies.get(source) ?? [];
            totalCount += count;
            windowTotal += wc;

            perSource[source] = {
                total_events: count,
                eps: elapsed > 0 ? Math.round((wc / elapsed) * 100) / 100 : 0,
                avg_latency_ms: lats.length > 0
                    ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length)
                    : null,
            };
        }

        const snapshot: MetricsSnapshot = {
            uptime_seconds: Math.floor((now - this.startTime) / 1000),
            total_events: totalCount,
            eps: elapsed > 0 ? Math.round((windowTotal / elapsed) * 100) / 100 : 0,
            window_seconds: Math.round(elapsed * 10) / 10,
            per_source: perSource,
        };

        // Roll the window if it's been long enough
        if (elapsed >= this.windowMs / 1000) {
            this.windowCounts.clear();
            this.windowStart = now;
        }

        return snapshot;
    }

    private startTime: number = Date.now();
}

export interface SourceMetrics {
    total_events: number;
    eps: number;
    avg_latency_ms: number | null;
}

export interface MetricsSnapshot {
    uptime_seconds: number;
    total_events: number;
    eps: number;
    window_seconds: number;
    per_source: Record<string, SourceMetrics>;
    active_matches?: string[];
}

export interface ServerInfo {
    hostname: string;
    total_events: number;
    last_seen: number;
    online: boolean;
}
