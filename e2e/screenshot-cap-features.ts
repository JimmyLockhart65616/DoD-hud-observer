/**
 * Visual check for the cap-attribution features:
 *   1. Capper NAMES in the flag cap feed (flag_captured now carries captor_ids).
 *   2. Kill-on-point CAP BREAK feed line (the cap_break event).
 *   3. The cap_breaks (BRK) column + capout-by title on the stats board.
 *
 * Mirrors screenshot-halftime.ts: stands up a Socket.IO server on :8000 (where
 * the mocker web build points) and drives events into the live store.
 *
 * Usage (start the mocker web dev server first, on :3010 → socket :8000):
 *   cd web && PORT=3010 REACT_APP_SOCKET_URL=http://localhost:8000 npx react-scripts start
 *   npx ts-node e2e/screenshot-cap-features.ts
 *
 * Output: e2e/snapshots/cap-feed.png, e2e/snapshots/cap-board.png
 */
import { chromium } from '@playwright/test';
import { Server } from 'socket.io';
import { createServer } from 'http';
import * as path from 'path';

const ALLIES: [string, string][] = [
    ['STEAM_0:0:1', 'mogers'], ['STEAM_0:0:2', 'fallen'], ['STEAM_0:0:3', 'sTarK'],
    ['STEAM_0:0:4', 'Lick.Stick'], ['STEAM_0:0:5', 'mizgif'], ['STEAM_0:0:6', 'bing bong'],
];
const AXIS: [string, string][] = [
    ['STEAM_0:1:1', 'warchild'], ['STEAM_0:1:2', 'jele'], ['STEAM_0:1:3', 'Gorilla'],
    ['STEAM_0:1:4', 'm00cat'], ['STEAM_0:1:5', 'stealth'], ['STEAM_0:1:6', 'player'],
];

const j = (event: string, payload: Record<string, unknown>) =>
    JSON.stringify({ tick: 600, match_id: 'screenshot', map: 'dod_anzio', match_type: 0, half: 1, ...payload, event });

// Board rows with a populated cap_breaks (BRK) column + caps.
function boardRows() {
    const mk = (team: string, list: [string, string][]) => list.map(([user_id, name], i) => ({
        user_id, name, team,
        kills: 28 - i * 3, deaths: 11 + i * 2, assists: 5 - (i % 3), damage: 3600 - i * 400,
        hs_kills: 5 - (i % 4), nade_kills: i % 3, gun_kills: 22 - i * 3,
        hits: 110 - i * 8, hs_hits: 9 - i, obj_score: 0,
        caps: (i + 1) % 3, cap_breaks: i % 2 === 0 ? 3 - (i >> 1) : 0, best_streak: 6 - i,
    }));
    return [...mk('allies', ALLIES), ...mk('axis', AXIS)];
}

async function main() {
    const httpServer = createServer();
    const io = new Server(httpServer, { cors: { origin: ['http://localhost:3010'], credentials: true } });

    let phase: 'feed' | 'board' = 'feed';
    io.on('connection', (socket) => {
        socket.emit('ktp_match_start', j('ktp_match_start', { half: 1 }));
        socket.emit('half_start', j('half_start', { half: 1, timeleft: 600 }));
        socket.emit('team_score', j('team_score', { allies_score: 2, axis_score: 1 }));
        // Roster so captor / breaker ids resolve to names.
        [...ALLIES.map(([id, name]) => ['allies', id, name] as const),
         ...AXIS.map(([id, name]) => ['axis', id, name] as const)]
            .forEach(([team, id, name]) =>
                socket.emit('player_connect', j('player_connect', { user_id: id, name, team })));

        // Feature 1: capper names in the cap feed (allies captured Anzio Plaza).
        socket.emit('flag_captured', j('flag_captured', {
            flag_id: 0, flag_name: 'Anzio Plaza', new_owner: 'allies',
            captor_ids: ['STEAM_0:0:1', 'STEAM_0:0:2'],
        }));
        // Feature 2: kill-on-point cap break (warchild broke the allies cap on The Bridge).
        socket.emit('cap_break', j('cap_break', {
            flag_id: 1, flag_name: 'The Bridge', reason: 'kill',
            breaker_id: 'STEAM_0:1:1', broke_team: 'allies',
        }));

        // Feature 3: the stats board (BRK column + capout-by title).
        if (phase === 'board') {
            socket.emit('player_stats_summary', j('player_stats_summary', {
                reason: 'round_end', capout_team: 'allies', capout_by: 'mogers, fallen',
                players: boardRows(),
            }));
        }
    });

    await new Promise<void>(r => httpServer.listen(8000, r));
    console.log('[shot] socket server on :8000');

    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });

    // Shot 1 — cap feed (capper names + kill-on-point cap break).
    const page1 = await ctx.newPage();
    await page1.goto('http://localhost:3010/screen');
    await page1.waitForSelector('.flagfeed-wrapper', { timeout: 20_000 });
    await page1.waitForTimeout(700);
    const feedPath = path.resolve(__dirname, 'snapshots', 'cap-feed.png');
    await page1.screenshot({ path: feedPath });
    console.log(feedPath);
    await page1.close();

    // Shot 2 — stats board with BRK column + "ALLIES CAPOUT BY mogers, fallen".
    phase = 'board';
    const page2 = await ctx.newPage();
    await page2.goto('http://localhost:3010/screen');
    await page2.waitForSelector('.stats-board', { timeout: 20_000 });
    await page2.waitForTimeout(800);
    const boardPath = path.resolve(__dirname, 'snapshots', 'cap-board.png');
    await page2.screenshot({ path: boardPath });
    console.log(boardPath);
    await page2.close();

    await browser.close();
    io.close();
    httpServer.close();
    process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
