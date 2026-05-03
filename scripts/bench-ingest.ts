/**
 * Ingest load benchmark.
 *
 * Replays the NY1 production fixture (backend/src/__tests__/fixtures/...) at a
 * configurable EPS rate against a running ingest endpoint and reports per-request
 * latency. Used to measure the ingest pipeline's per-event cost in isolation
 * from network jitter and to validate Bug 2 option-3 fixes (matchRecorder write
 * path, socket fan-out, etc).
 *
 * Usage:
 *   npx ts-node scripts/bench-ingest.ts \
 *       --url http://localhost:8088/ingest \
 *       --auth changeme \
 *       --eps 100 \
 *       --concurrency 5 \
 *       --duration 30
 *
 * The --concurrency knob simulates N canary game servers each opening their
 * own keep-alive connection. The driver paces the aggregate so total throughput
 * matches --eps; per-connection rate = eps / concurrency.
 */

import http from 'http';
import { URL } from 'url';
import path from 'path';
import fs from 'fs';
import zlib from 'zlib';

interface Args {
    url: string;
    auth: string;
    eps: number;
    concurrency: number;
    durationS: number;
    matchIdSuffix: string;
}

function parseArgs(): Args {
    const args: Args = {
        url: 'http://localhost:8088/ingest',
        auth: 'changeme',
        eps: 50,
        concurrency: 5,
        durationS: 30,
        matchIdSuffix: `bench-${Date.now()}`,
    };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const [flag, val] = [argv[i], argv[i + 1]];
        switch (flag) {
            case '--url':         args.url = val; i++; break;
            case '--auth':        args.auth = val; i++; break;
            case '--eps':         args.eps = parseInt(val, 10); i++; break;
            case '--concurrency': args.concurrency = parseInt(val, 10); i++; break;
            case '--duration':    args.durationS = parseInt(val, 10); i++; break;
            case '--suffix':      args.matchIdSuffix = val; i++; break;
            case '--help':
            case '-h':
                console.log('See header comment.');
                process.exit(0);
        }
    }
    return args;
}

function loadFixture(): Array<Record<string, unknown>> {
    const fixturePath = path.join(
        __dirname, '..', 'backend', 'src', '__tests__', 'fixtures', 'match-1777342963-NY1.jsonl.gz',
    );
    const gz = fs.readFileSync(fixturePath);
    return zlib.gunzipSync(gz).toString('utf-8')
        .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

interface Stats {
    sent: number;
    completed: number;
    errors: number;
    latencies: number[];   // raw ms latencies (write-then-response time)
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
    return sorted[idx];
}

function summary(label: string, latencies: number[]): string {
    if (latencies.length === 0) return `${label}: no samples`;
    const sorted = [...latencies].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return [
        `${label}: n=${sorted.length}`,
        `mean=${(sum / sorted.length).toFixed(2)}ms`,
        `p50=${percentile(sorted, 0.50).toFixed(2)}`,
        `p95=${percentile(sorted, 0.95).toFixed(2)}`,
        `p99=${percentile(sorted, 0.99).toFixed(2)}`,
        `max=${sorted[sorted.length - 1].toFixed(2)}`,
    ].join('  ');
}

async function main(): Promise<void> {
    const args = parseArgs();
    const url = new URL(args.url);
    const events = loadFixture();
    console.log(`[bench] Loaded ${events.length} events from NY1 fixture`);
    console.log(`[bench] Target: ${args.url}  rate=${args.eps} EPS  concurrency=${args.concurrency}  duration=${args.durationS}s`);

    const agent = new http.Agent({ keepAlive: true, maxSockets: args.concurrency });
    const matchId = `${events.find(e => e.match_id)?.match_id ?? 'bench'}-${args.matchIdSuffix}`;

    // Rewrite each event's match_id so we don't collide with real matches
    const rewritten = events.map(e => ({ ...e, match_id: matchId }));

    const stats: Stats = { sent: 0, completed: 0, errors: 0, latencies: [] };

    function postOne(event: Record<string, unknown>): Promise<void> {
        return new Promise((resolve) => {
            const body = JSON.stringify(event);
            const start = process.hrtime.bigint();
            const req = http.request({
                hostname: url.hostname,
                port: url.port || 80,
                path: url.pathname,
                method: 'POST',
                agent,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'X-Auth-Key': args.auth,
                    'X-Server-Hostname': `bench-${args.matchIdSuffix}`,
                    'X-Plugin-Sent-At': String(Date.now()),
                },
            }, (res) => {
                res.resume();
                res.on('end', () => {
                    const ns = Number(process.hrtime.bigint() - start);
                    const ms = ns / 1_000_000;
                    if (res.statusCode === 200) {
                        stats.completed++;
                        stats.latencies.push(ms);
                    } else {
                        stats.errors++;
                    }
                    resolve();
                });
            });
            req.on('error', () => { stats.errors++; resolve(); });
            req.write(body);
            req.end();
        });
    }

    // Pacing: dispatch one event every (1000 / eps) ms. Sequential dispatch;
    // the http.Agent's keepAlive pool handles concurrency naturally.
    const intervalMs = 1000 / args.eps;
    const startedAt = Date.now();
    const deadline = startedAt + args.durationS * 1000;
    let cursor = 0;

    // Periodic snapshot
    const reportTimer = setInterval(() => {
        const window = stats.latencies.slice(-Math.min(stats.latencies.length, args.eps * 5));
        console.log(`[bench] t+${((Date.now() - startedAt) / 1000).toFixed(0)}s  sent=${stats.sent}  ok=${stats.completed}  err=${stats.errors}  ${summary('window-5s', window)}`);
    }, 5000);

    const inflight: Promise<void>[] = [];
    while (Date.now() < deadline) {
        const event = rewritten[cursor % rewritten.length];
        cursor++;
        stats.sent++;
        inflight.push(postOne(event));
        // Trim resolved promises so the array doesn't grow unbounded
        if (inflight.length >= args.concurrency * 4) {
            await Promise.race(inflight).catch(() => {});
            // Shed any settled
            for (let i = inflight.length - 1; i >= 0; i--) {
                if ((inflight[i] as any).__settled) inflight.splice(i, 1);
            }
        }
        // Pace
        const targetSent = ((Date.now() - startedAt) / 1000) * args.eps;
        if (stats.sent > targetSent) {
            await new Promise(r => setTimeout(r, intervalMs));
        }
    }

    clearInterval(reportTimer);
    await Promise.all(inflight).catch(() => {});

    const elapsed = (Date.now() - startedAt) / 1000;
    console.log('\n[bench] DONE');
    console.log(`[bench] elapsed=${elapsed.toFixed(2)}s  sent=${stats.sent}  ok=${stats.completed}  err=${stats.errors}  actual_eps=${(stats.completed / elapsed).toFixed(1)}`);
    console.log(`[bench] ${summary('total', stats.latencies)}`);
    agent.destroy();
}

main().catch(e => { console.error(e); process.exit(1); });
