import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './e2e',
    timeout: 90_000,
    expect: { timeout: 10_000 },
    fullyParallel: false,
    retries: 0,
    reporter: 'html',

    use: {
        baseURL: 'http://localhost:3000',
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
            command: 'npx ts-node --script-mode backend/src/mocker/mocker.ts',
            port: 8000,
            reuseExistingServer: true,
            timeout: 30_000,
        },
        {
            command: 'npx env-cmd -f .env.mocker react-scripts start',
            port: 3000,
            cwd: './web',
            reuseExistingServer: true,
            timeout: 60_000,
        },
    ],
});
