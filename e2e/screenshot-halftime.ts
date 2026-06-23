/**
 * One-off visual check for the halftime / match-end stats board + full-screen
 * backdrop (the "completely cover the DoD scoreboard" change).
 *
 * The normal mocker timeline never emits a stats summary, so the boards never
 * render under `npm run e2e`. This harness stands up its own Socket.IO server on
 * :8000 (the port `.env.mocker` points the web app at), drives a half_end summary
 * into the live store, and screenshots the result.
 *
 * Usage (start the mocker web dev server first):
 *   cd web && npx env-cmd -f .env.mocker react-scripts start     # serves :3010 → socket :8000
 *   npx ts-node e2e/screenshot-halftime.ts [--reason half_end|match_end]
 *
 * Output: e2e/snapshots/<reason>-backdrop.png  (read it to inspect the layout).
 */
import { chromium } from '@playwright/test';
import { Server } from 'socket.io';
import { createServer } from 'http';
import * as path from 'path';

const reason = (() => {
    const i = process.argv.indexOf('--reason');
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'half_end';
})();

const NAMES_ALLIES = ['mogers', 'bing bong', 'sTarK', 'fallen', 'Lick.Stick', 'mizgif'];
const NAMES_AXIS   = ['warchild', 'jele', 'player', 'Gorilla', 'm00cat', 'stealth'];

function rows() {
    const mk = (team: string, names: string[]) => names.map((name, i) => ({
        user_id: `STEAM_0:${team === 'allies' ? 0 : 1}:${1000 + i}`,
        name, team,
        kills: 30 - i * 3, deaths: 12 + i * 2, assists: 4 - (i % 3), damage: 3800 - i * 420,
        hs_kills: 6 - (i % 4), nade_kills: i % 3, gun_kills: 24 - i * 3,
        hits: 120 - i * 8, hs_hits: 10 - i, caps: (i + 1) % 3, best_streak: 7 - i, obj_score: 0,
    }));
    return [...mk('allies', NAMES_ALLIES), ...mk('axis', NAMES_AXIS)];
}

const j = (event: string, payload: Record<string, unknown>) =>
    JSON.stringify({ tick: 600, match_id: 'screenshot', map: 'dod_anzio', match_type: 0, half: 1, ...payload, event });

async function main() {
    const httpServer = createServer();
    const io = new Server(httpServer, { cors: { origin: ['http://localhost:3010'], credentials: true } });

    io.on('connection', (socket) => {
        // Open a fresh half-1 match, seed the score bar, then drop the board.
        socket.emit('ktp_match_start', j('ktp_match_start', { half: 1 }));
        socket.emit('half_start', j('half_start', { half: 1, timeleft: 600 }));
        socket.emit('team_score', j('team_score', { allies_score: 4, axis_score: 5 }));
        socket.emit('player_stats_summary', j('player_stats_summary', { reason, players: rows() }));
    });

    await new Promise<void>(r => httpServer.listen(8000, r));
    console.log('[shot] socket server on :8000');

    const browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
    await page.goto('http://localhost:3010/screen');
    await page.waitForSelector('.stats-board', { timeout: 20_000 });
    await page.waitForTimeout(800); // let the fade-in settle

    const outPath = path.resolve(__dirname, 'snapshots', `${reason}-backdrop.png`);
    await page.screenshot({ path: outPath, fullPage: false });
    console.log(outPath);

    await browser.close();
    io.close();
    httpServer.close();
    process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
