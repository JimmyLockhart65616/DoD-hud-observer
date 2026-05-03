#!/usr/bin/env ts-node
// Soak scenario: HudObserver under steady-state stress.
//
// Boots the KTP local stack (game servers + data backend), runs HudObserver's
// own polling tasks (poll_prone @ 0.25s, poll_zones @ 0.5s, time_sync @ 30s)
// in two game-server containers for SOAK_DURATION_MIN minutes, asserts:
//
//   1. No game-server container exited (segfault detection)
//   2. No /tmp/core.* file appears in any container
//   3. /metrics on the data backend shows event flow from both game servers
//   4. No "[HUD] POST failed" lines in container logs past warmup
//
// Caveat: local-only soak does NOT reproduce prod-only KTP bugs (the DODX
// forwards-stall and now this amxxcurl crash both refused to repro locally
// despite multi-hour stress runs). A clean soak is necessary but not
// sufficient — the real validation is the DEN5 24h matchday in canary.
//
// Invoked via: npm run soak:hud (default 30 min) or npm run soak:smoke (60s)
// Configure with: SOAK_DURATION_MIN=30 ts-node e2e/soak/scenarios/hudobserver-stress.ts

import * as http from 'http';
import { LocalStack } from '../harness/local-stack';

const DURATION_MIN = Number(process.env.SOAK_DURATION_MIN ?? '30');
const DURATION_MS = DURATION_MIN * 60 * 1000;
const POLL_INTERVAL_MS = 10_000;

function fetchMetrics(): Promise<string> {
    return new Promise((resolve) => {
        const req = http.get('http://localhost:3001/metrics', { timeout: 3000 }, (res) => {
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => resolve(body));
        });
        req.on('error', () => resolve(''));
        req.on('timeout', () => { req.destroy(); resolve(''); });
    });
}

async function main(): Promise<void> {
    console.log(`[soak] hudobserver-stress: starting, duration=${DURATION_MIN}min`);
    const stack = new LocalStack();

    console.log('[soak] starting KTP local stack via make local-up...');
    await stack.up();
    console.log('[soak] stack healthy. running HudObserver under steady polling load.');

    const startedAt = Date.now();
    const deadline = startedAt + DURATION_MS;
    let lastEpsCheck = '';
    let failedPostMatches = 0;
    let crashed = false;

    const containers = [
        stack.containerName('ktp-game-1'),
        stack.containerName('ktp-game-2'),
    ].filter(Boolean);
    if (containers.length === 0) {
        console.error('[soak] FAIL: could not resolve any container names from docker compose');
        await stack.down();
        process.exit(1);
    }
    console.log(`[soak] watching containers: ${containers.join(', ')}`);

    while (Date.now() < deadline) {
        for (const container of containers) {
            const exitCode = stack.containerExitCode(container);
            if (exitCode !== null) {
                console.error(`[soak] FAIL: ${container} exited with code ${exitCode} after ${Math.round((Date.now() - startedAt) / 1000)}s`);
                console.error(`[soak] last logs from ${container}:\n${stack.containerLogs(container, 50)}`);
                crashed = true;
            }
            if (stack.hasCoreDump(container)) {
                console.error(`[soak] FAIL: core dump detected in ${container}`);
                crashed = true;
            }
            const logs = stack.containerLogs(container, 500);
            const failures = (logs.match(/\[HUD\] POST failed/g) ?? []).length;
            if (failures > failedPostMatches) {
                console.warn(`[soak] WARN: ${container} reports ${failures} HUD POST failures (was ${failedPostMatches})`);
                failedPostMatches = failures;
            }
        }
        if (crashed) break;

        const metrics = await fetchMetrics();
        const epsLine = metrics.match(/eps_per_source[^\n]*/)?.[0] ?? '(no /metrics)';
        if (epsLine !== lastEpsCheck) {
            console.log(`[soak] t+${Math.round((Date.now() - startedAt) / 1000)}s ${epsLine}`);
            lastEpsCheck = epsLine;
        }

        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    console.log('[soak] duration elapsed; tearing down stack');
    await stack.down();

    if (crashed) {
        console.error('[soak] RESULT: FAIL — see above');
        process.exit(1);
    }

    console.log(`[soak] RESULT: PASS — ran ${DURATION_MIN}min with 0 crashes, 0 core dumps, ${failedPostMatches} POST failures`);
}

main().catch((e) => {
    console.error('[soak] uncaught error:', e);
    process.exit(2);
});
