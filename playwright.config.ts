import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './e2e',
    // The single spec walks the WHOLE mocker script: TIMELINE_END is 75s
    // (e2e/helpers/mocker-timeline.ts) and the match_end board lands at ~77s, and
    // none of that starts until the page has loaded and the socket has connected —
    // the mocker begins emitting on connect. At the old 90s this left <15s for a
    // cold CRA compile + first paint, so the run failed partway down the timeline
    // (checkpoint 11) on any machine that wasn't warm. 180s is ~2.3x the scripted
    // length: still fails fast if the timeline genuinely stalls, but no longer
    // races the dev server. Raise TIMELINE_END and this needs raising with it.
    timeout: 180_000,
    expect: { timeout: 10_000 },
    fullyParallel: false,
    retries: 0,
    reporter: 'html',

    // E2E runs on :3010 (React) and :8000 (mocker) so it never collides with the
    // Docker `data` container (which serves the production-bundle React on :3000).
    // reuseExistingServer is OFF on both so a stale mocker/dev-server can't pollute
    // the scripted timeline — fail fast, don't silently test the wrong stack.
    use: {
        baseURL: 'http://localhost:3010',
        viewport: { width: 1920, height: 1080 },
        screenshot: 'off',
        trace: 'off',
    },

    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } },
        },
    ],

    webServer: [
        {
            command: 'npx ts-node --script-mode backend/src/mocker/mocker.ts -- --socket',
            port: 8000,
            reuseExistingServer: false,
            timeout: 30_000,
        },
        {
            command: 'npx env-cmd -f .env.mocker react-scripts start',
            port: 3010,
            cwd: './web',
            reuseExistingServer: false,
            timeout: 60_000,
        },
    ],
});
