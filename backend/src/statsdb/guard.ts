/**
 * Load protection for the `/api/stats/*` routes.
 *
 * These are PUBLIC and UNAUTHENTICATED, and they read a MySQL instance that
 * shares the data server with the HLStatsX daemon, the HLTV proxies, hltv-api,
 * the anti-cheat API and this backend itself. That box is busy. A stats read is
 * never worth degrading any of it, and certainly never worth degrading the live
 * broadcast overlay this same process is serving.
 *
 * So everything here fails CLOSED: when in doubt, stop querying and answer 503.
 * A caster page that briefly cannot show career numbers is a non-event; a
 * database that falls over mid-match is not.
 *
 * Layers, outermost first:
 *   1. TTL cache          — repeat polling never reaches MySQL at all
 *   2. Per-IP rate limit  — it is public
 *   3. Concurrency cap    — pile-ups shed instead of queueing
 *   4. Circuit breaker    — trips on ERRORS *or* SLOWNESS, auto half-open probe
 * plus, in queries.ts / statsDb.ts:
 *   5. MAX_EXECUTION_TIME — MySQL aborts the query server-side, independent of us
 *   6. client query timeout and a tiny pool with queueLimit
 */

export interface GuardOptions {
    /** Consecutive failures (or slow calls) before the breaker opens. */
    failureThreshold: number;
    /** How long the breaker stays open before a single probe is allowed. */
    openMs: number;
    /** A call slower than this counts as a failure even if it succeeded. */
    slowCallMs: number;
    /** Max concurrent in-flight queries; beyond this we shed. */
    maxConcurrent: number;
    /** Requests per IP per window. */
    rateLimit: number;
    rateWindowMs: number;
}

export const DEFAULTS: GuardOptions = {
    // Three strikes rather than one: a single blip (a lock wait, a GC pause on
    // the daemon) should not take the feature down for everyone.
    failureThreshold: 3,
    openMs: 30_000,
    // Deliberately well under the MySQL-side MAX_EXECUTION_TIME. If queries are
    // routinely taking this long the database is under pressure and we should
    // back off BEFORE it starts killing statements — the point is to notice the
    // server struggling, not to wait for it to fail outright.
    slowCallMs: 750,
    maxConcurrent: 4,
    rateLimit: 60,
    rateWindowMs: 60_000,
};

export type BreakerState = 'closed' | 'open' | 'half-open';

export class StatsGuard {
    private opts: GuardOptions;
    private failures = 0;
    private openedAt = 0;
    private state: BreakerState = 'closed';
    private inFlight = 0;
    private probeInFlight = false;
    private hits = new Map<string, { count: number; resetAt: number }>();
    private cache = new Map<string, { at: number; ttl: number; value: unknown }>();

    // Counters for /metrics and for explaining a 503 in the logs.
    readonly stats = { shedConcurrency: 0, shedRate: 0, shedOpen: 0, cacheHits: 0, trips: 0 };

    constructor(opts: Partial<GuardOptions> = {}) {
        this.opts = { ...DEFAULTS, ...opts };
    }

    getState(): BreakerState {
        // Lazily transition open -> half-open so callers see the real state
        // without needing a timer running.
        if (this.state === 'open' && Date.now() - this.openedAt >= this.opts.openMs) {
            this.state = 'half-open';
            this.probeInFlight = false;
        }
        return this.state;
    }

    /**
     * Rate limit keyed on client IP. A fixed window, not a sliding one: the
     * worst case is 2x the limit across a window boundary, which is irrelevant
     * at this scale and costs one map entry per IP instead of a timestamp list.
     */
    allowRate(key: string): boolean {
        const now = Date.now();
        const e = this.hits.get(key);
        if (!e || now >= e.resetAt) {
            this.hits.set(key, { count: 1, resetAt: now + this.opts.rateWindowMs });
            if (this.hits.size > 5000) this.pruneRate(now);
            return true;
        }
        if (e.count >= this.opts.rateLimit) {
            this.stats.shedRate++;
            return false;
        }
        e.count++;
        return true;
    }

    private pruneRate(now: number): void {
        for (const [k, v] of this.hits) if (now >= v.resetAt) this.hits.delete(k);
    }

    getCached<T>(key: string): T | undefined {
        const e = this.cache.get(key);
        if (!e) return undefined;
        if (Date.now() - e.at > e.ttl) { this.cache.delete(key); return undefined; }
        this.stats.cacheHits++;
        return e.value as T;
    }

    setCached(key: string, value: unknown, ttlMs: number): void {
        // Bounded so a crawler walking match ids cannot grow this without limit.
        if (this.cache.size > 500) {
            const oldest = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
            if (oldest) this.cache.delete(oldest[0]);
        }
        this.cache.set(key, { at: Date.now(), ttl: ttlMs, value });
    }

    /**
     * Runs `work` behind the breaker and the concurrency cap.
     * Returns `null` when the call was SHED — the caller answers 503 and must
     * not retry, because a retry is exactly the load we are shedding.
     */
    async run<T>(work: () => Promise<T>): Promise<T | null> {
        const state = this.getState();

        if (state === 'open') { this.stats.shedOpen++; return null; }

        // In half-open, exactly ONE probe is allowed through. Everything else
        // sheds — otherwise the whole backlog stampedes a database that has just
        // shown it is unwell.
        if (state === 'half-open') {
            if (this.probeInFlight) { this.stats.shedOpen++; return null; }
            this.probeInFlight = true;
        } else if (this.inFlight >= this.opts.maxConcurrent) {
            this.stats.shedConcurrency++;
            return null;
        }

        this.inFlight++;
        const started = Date.now();
        try {
            const out = await work();
            const elapsed = Date.now() - started;
            // A succeeded-but-slow call still counts against us: the database is
            // telling us it is under pressure while it can still answer.
            if (elapsed >= this.opts.slowCallMs) this.recordFailure();
            else this.recordSuccess();
            return out;
        } catch (err) {
            this.recordFailure();
            throw err;
        } finally {
            this.inFlight--;
            if (state === 'half-open') this.probeInFlight = false;
        }
    }

    private recordSuccess(): void {
        this.failures = 0;
        this.state = 'closed';
    }

    private recordFailure(): void {
        this.failures++;
        // A failed probe in half-open re-opens immediately — one strike, not
        // three. We already know it is unhealthy; the probe was the retry.
        if (this.state === 'half-open' || this.failures >= this.opts.failureThreshold) {
            if (this.state !== 'open') this.stats.trips++;
            this.state = 'open';
            this.openedAt = Date.now();
            this.failures = 0;
        }
    }

    /** Diagnostics for /metrics. */
    snapshot() {
        return {
            state: this.getState(),
            inFlight: this.inFlight,
            cacheEntries: this.cache.size,
            ...this.stats,
        };
    }

    /** Test seam. */
    reset(): void {
        this.failures = 0;
        this.state = 'closed';
        this.inFlight = 0;
        this.probeInFlight = false;
        this.hits.clear();
        this.cache.clear();
        for (const k of Object.keys(this.stats) as (keyof typeof this.stats)[]) this.stats[k] = 0;
    }
}
