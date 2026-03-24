/**
 * Ad-hoc screenshot tool for interactive HUD debugging.
 *
 * Usage (requires mocker + React already running):
 *   npx ts-node e2e/screenshot-tool.ts [--wait <ms>] [--name <name>] [--selector <css>]
 *
 * Examples:
 *   npx ts-node e2e/screenshot-tool.ts                              # wait 5s, default name
 *   npx ts-node e2e/screenshot-tool.ts --wait 15000 --name kills    # wait 15s
 *   npx ts-node e2e/screenshot-tool.ts --selector ".flags-container" --name flags
 */

import { chromium } from '@playwright/test';
import * as path from 'path';

async function main() {
    const args = process.argv.slice(2);

    let waitMs = 5000;
    let name = 'screenshot';
    let selector: string | null = null;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--wait' && args[i + 1]) waitMs = parseInt(args[++i], 10);
        if (args[i] === '--name' && args[i + 1]) name = args[++i];
        if (args[i] === '--selector' && args[i + 1]) selector = args[++i];
    }

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();

    await page.goto('http://localhost:3000/screen');

    if (selector) {
        console.log(`Waiting for selector: ${selector}`);
        await page.waitForSelector(selector, { timeout: waitMs + 10_000 });
    }

    if (waitMs > 0) {
        console.log(`Waiting ${waitMs}ms for events...`);
        await page.waitForTimeout(waitMs);
    }

    const outPath = path.resolve(__dirname, 'snapshots', `${name}.png`);
    await page.screenshot({ path: outPath, fullPage: false });
    console.log(outPath);

    await browser.close();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
