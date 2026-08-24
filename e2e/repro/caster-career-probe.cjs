/**
 * Why is the /caster career panel not rendering?
 *
 * Loads the page against the local Docker stack and reports what the browser
 * actually did with /api/stats/players — status code, body, console errors. The
 * panel deliberately renders NOTHING on a 503, so "missing panel" and "endpoint
 * switched off" look identical from a screenshot.
 *
 * Usage: node e2e/repro/caster-career-probe.cjs [url]
 */
const { chromium } = require('@playwright/test');

const URL = process.argv[2] || 'https://localhost/caster?server=mocker';

(async () => {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
    const page = await ctx.newPage();

    page.on('console', m => console.log(`[console.${m.type()}]`, m.text()));
    page.on('pageerror', e => console.log('[pageerror]', e.message));
    page.on('requestfailed', r => console.log('[requestfailed]', r.url(), r.failure() && r.failure().errorText));

    page.on('response', async res => {
        if (!res.url().includes('/api/stats/')) return;
        let body = '';
        try { body = (await res.text()).slice(0, 300); } catch (e) { body = `<unreadable: ${e.message}>`; }
        console.log(`[api] ${res.status()} ${res.url()}\n      ${body.replace(/\s+/g, ' ')}`);
    });

    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(20_000);

    console.log(JSON.stringify({
        rosterRows: await page.locator('.caster-loadout').count(),
        careerPanels: await page.locator('.caster-panel-career').count(),
        careerRows: await page.locator('.caster-career-row').count(),
    }));

    await browser.close();
})();
