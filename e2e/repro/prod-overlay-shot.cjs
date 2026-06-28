// PROD overlay headless screenshot + timer scrape — the literal "hit the prod URL
// and see what you're getting" tool. Loads the real overlay in headless chromium,
// waits for the socket to connect + the timer to populate, reads the rendered
// `.timer-area` text, and writes a full-overlay PNG for visual inspection.
//
// Usage:
//   node e2e/repro/prod-overlay-shot.cjs ["KTP - Atlanta 1"] [--wait 6000] [--out <png path>]
const { chromium } = require('@playwright/test');

function arg(name, def) {
    const i = process.argv.indexOf(name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const SERVER = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'KTP - Atlanta 1';
const WAIT = parseInt(arg('--wait', '6000'), 10);
const OUT = arg('--out', `${process.env.TEMP || '/tmp'}/prod-overlay.png`);
const URL = `http://74.91.112.242:3000/screen?server=${encodeURIComponent(SERVER)}`;

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    console.log(`loading ${URL}`);
    await page.goto(URL, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(WAIT);
    let timer = null;
    try { timer = (await page.locator('.timer-area').first().innerText({ timeout: 3000 })).trim(); } catch (_) {}
    await page.screenshot({ path: OUT, fullPage: false });
    console.log(`timer-area text: ${timer == null ? '(not found)' : JSON.stringify(timer)}`);
    console.log(`screenshot: ${OUT}`);
    await browser.close();
    process.exit(0);
})();
