import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './e2e',
    timeout: 90_000,
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
