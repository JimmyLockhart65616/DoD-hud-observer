/**
 * The load-protection contract for /api/stats/*.
 *
 * These endpoints are public, unauthenticated, and read a MySQL instance shared
 * with the HLStatsX daemon, the HLTV proxies and this backend's own live
 * broadcast path. Everything here must fail CLOSED — the tests below exist so a
 * later refactor cannot quietly turn "shed the request" into "queue it up".
 */
import { StatsGuard } from '../statsdb/guard';
import { withExecutionCap, MAX_EXECUTION_TIME_MS } from '../statsdb/queries';

const ok = () => Promise.resolve('ok');
const boom = () => Promise.reject(new Error('db down'));

async function failTimes(g: StatsGuard, n: number) {
    for (let i = 0; i < n; i++) {
        await g.run(boom).catch(() => undefined);
    }
}

describe('circuit breaker', () => {
    it('starts closed and passes work through', async () => {
        const g = new StatsGuard();
        expect(g.getState()).toBe('closed');
        await expect(g.run(ok)).resolves.toBe('ok');
    });

    it('opens after the failure threshold and then sheds without calling through', async () => {
        const g = new StatsGuard({ failureThreshold: 3 });
        await failTimes(g, 3);
        expect(g.getState()).toBe('open');

        // The important part: work is NOT invoked while open.
        let called = false;
        const out = await g.run(async () => { called = true; return 'x'; });
        expect(out).toBeNull();
        expect(called).toBe(false);
    });

    it('a single blip does not trip it', async () => {
        const g = new StatsGuard({ failureThreshold: 3 });
        await failTimes(g, 2);
        await g.run(ok);
        expect(g.getState()).toBe('closed');
    });

    it('counts a SLOW success as a failure', async () => {
        // A database that still answers but answers slowly is a database under
        // pressure. Backing off then is the whole point — waiting for hard
        // errors would mean only reacting once it is already failing.
        const g = new StatsGuard({ failureThreshold: 2, slowCallMs: 10 });
        const slow = () => new Promise(r => setTimeout(() => r('slow'), 30));
        await g.run(slow);
        await g.run(slow);
        expect(g.getState()).toBe('open');
    });

    it('half-opens after the cooldown and lets exactly one probe through', async () => {
        const g = new StatsGuard({ failureThreshold: 1, openMs: 20 });
        await failTimes(g, 1);
        expect(g.getState()).toBe('open');

        await new Promise(r => setTimeout(r, 30));
        expect(g.getState()).toBe('half-open');

        let started = 0;
        const slowOk = () => new Promise(r => { started++; setTimeout(() => r('ok'), 20); });
        const first  = g.run(slowOk);
        const second = await g.run(slowOk);   // must be shed, not stampede
        expect(second).toBeNull();
        expect(started).toBe(1);
        await first;
    });

    it('a failed probe re-opens immediately rather than after another N strikes', async () => {
        const g = new StatsGuard({ failureThreshold: 3, openMs: 10 });
        await failTimes(g, 3);
        await new Promise(r => setTimeout(r, 20));
        expect(g.getState()).toBe('half-open');
        await g.run(boom).catch(() => undefined);
        expect(g.getState()).toBe('open');
    });

    it('recovers to closed after a good probe', async () => {
        const g = new StatsGuard({ failureThreshold: 1, openMs: 10 });
        await failTimes(g, 1);
        await new Promise(r => setTimeout(r, 20));
        await g.run(ok);
        expect(g.getState()).toBe('closed');
    });
});

describe('concurrency cap', () => {
    it('sheds beyond maxConcurrent instead of queueing', async () => {
        const g = new StatsGuard({ maxConcurrent: 2 });
        const hold = () => new Promise(r => setTimeout(() => r('held'), 40));
        const a = g.run(hold);
        const b = g.run(hold);
        const c = await g.run(hold);      // third must shed immediately
        expect(c).toBeNull();
        await Promise.all([a, b]);
        expect(g.snapshot().shedConcurrency).toBe(1);
    });

    it('frees capacity once work settles, including on failure', async () => {
        const g = new StatsGuard({ maxConcurrent: 1, failureThreshold: 99 });
        await g.run(boom).catch(() => undefined);
        await expect(g.run(ok)).resolves.toBe('ok');
    });
});

describe('rate limit', () => {
    it('allows up to the limit then rejects, per key', async () => {
        const g = new StatsGuard({ rateLimit: 3, rateWindowMs: 10_000 });
        expect(g.allowRate('1.2.3.4')).toBe(true);
        expect(g.allowRate('1.2.3.4')).toBe(true);
        expect(g.allowRate('1.2.3.4')).toBe(true);
        expect(g.allowRate('1.2.3.4')).toBe(false);
        // A different client is unaffected.
        expect(g.allowRate('5.6.7.8')).toBe(true);
    });

    it('resets after the window', async () => {
        const g = new StatsGuard({ rateLimit: 1, rateWindowMs: 20 });
        expect(g.allowRate('ip')).toBe(true);
        expect(g.allowRate('ip')).toBe(false);
        await new Promise(r => setTimeout(r, 30));
        expect(g.allowRate('ip')).toBe(true);
    });
});

describe('cache', () => {
    it('returns a hit inside the TTL and expires after it', async () => {
        const g = new StatsGuard();
        g.setCached('k', { v: 1 }, 30);
        expect(g.getCached('k')).toEqual({ v: 1 });
        await new Promise(r => setTimeout(r, 45));
        expect(g.getCached('k')).toBeUndefined();
    });

    it('is bounded so a crawler cannot grow it without limit', () => {
        const g = new StatsGuard();
        for (let i = 0; i < 600; i++) g.setCached(`k${i}`, i, 60_000);
        expect(g.snapshot().cacheEntries).toBeLessThanOrEqual(501);
    });
});

describe('MySQL-side execution cap', () => {
    // The layer that protects the shared server even if this process misbehaves:
    // MySQL aborts the statement itself (error 3024). Verified against a real
    // MySQL 8 — the same query runs >6s unhinted and dies at 300ms with it.
    it('injects the hint immediately after SELECT', () => {
        expect(withExecutionCap('SELECT a FROM t'))
            .toBe(`SELECT /*+ MAX_EXECUTION_TIME(${MAX_EXECUTION_TIME_MS}) */ a FROM t`);
    });

    it('is idempotent', () => {
        const once = withExecutionCap('SELECT a FROM t');
        expect(withExecutionCap(once)).toBe(once);
    });

    it('is applied to every shipped query', () => {
        const q = require('../statsdb/queries');
        for (const name of ['RECENT_MATCHES', 'MATCH_PLAYER_STATS', 'PLAYER_CAREER', 'FLAG_POSITIONS', 'POSITION_SAMPLES']) {
            expect(withExecutionCap(q[name])).toMatch(/^SELECT \/\*\+ MAX_EXECUTION_TIME\(\d+\)/);
        }
    });
});
