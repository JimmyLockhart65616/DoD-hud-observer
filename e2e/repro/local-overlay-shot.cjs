// Ad-hoc: screenshot the LOCAL docker stack's /screen overlay and scrape the
// match-phase caption. Mirrors e2e/repro/prod-overlay-shot.cjs but points at
// localhost:3000 (the data container's frontend).
//
//   node local-overlay-shot.cjs "KTP Local Dev #1" [--wait 8000] [--out x.png]
const { chromium } = require('@playwright/test');

function arg(name, def) {
    const i = process.argv.indexOf(name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const SERVER = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'KTP Local Dev #1';
const WAIT = parseInt(arg('--wait', '8000'), 10);
const OUT = arg('--out', 'local-overlay.png');
const PAGE = arg('--page', 'screen');
// The docker stack is single-origin behind nginx on :443 — :3000 serves the
// static bundle but has no /socket.io/, so a page loaded there never connects.
const ORIGIN = arg('--origin', 'https://localhost');
const URL = `${ORIGIN}/${PAGE}?server=${encodeURIComponent(SERVER)}`;

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
        viewport: { width: 1280, height: 720 },
        ignoreHTTPSErrors: true,   // start.sh self-signs a fallback cert
    });
    console.log(`loading ${URL}`);
    await page.goto(URL, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(WAIT);

    const read = await page.evaluate(() => {
        const t = (sel) => document.querySelector(sel)?.textContent ?? null;
        const score = document.querySelector('.score');
        const bar = document.querySelector('.top-bar');
        return {
            phase: t('.match-phase'),
            phaseClass: document.querySelector('.match-phase')?.className ?? null,
            // /caster uses its own terser vocabulary in a separate element.
            casterPhase: t('.caster-phase'),
            casterHalf: t('.caster-half'),
            timer: t('.timer-area'),
            allies: t('.allies-score'),
            axis: t('.axis-score'),
            scoreHeight: score ? score.getBoundingClientRect().height : null,
            topBarHeight: bar ? bar.getBoundingClientRect().height : null,
        };
    });
    // Second clock sample in the SAME page session — the only way to tell a
    // frozen clock from a running one (separate page loads each re-anchor off a
    // fresh snapshot and are not comparable).
    await page.waitForTimeout(3000);
    read.timerAfter3s = await page.evaluate(
        () => document.querySelector('.timer-area')?.textContent
            ?? document.querySelector('.caster-clock')?.textContent ?? null);
    read.clockMoved = read.timer !== read.timerAfter3s;

    console.log(JSON.stringify(read, null, 2));
    await page.screenshot({ path: OUT, fullPage: false });
    console.log(`wrote ${OUT}`);
    await browser.close();
})();
