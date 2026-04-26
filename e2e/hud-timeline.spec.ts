import { test, expect } from '@playwright/test';
import { takeScreenshot } from './helpers/screenshot';
import { waitForPlayers, waitForKillFeed, waitForFlags } from './helpers/wait-helpers';
import { ALLIES_NAMES, AXIS_NAMES } from './helpers/mocker-timeline';

test.describe('HUD Mocker Timeline', () => {

    test('full mocker sequence', async ({ page }) => {
        // Navigate to HUD screen — this triggers Socket.IO connection,
        // which triggers mocker to start emitting events.
        await page.goto('/screen');

        // ── Checkpoint 1: Players appear (after ~1.2s) ──────────────
        await waitForPlayers(page, 6, 6);
        await takeScreenshot(page, '01-players-spawned');

        // Assert all 12 player names visible
        const teamCards = page.locator('.bottom-bar .team-cards');
        for (const name of ALLIES_NAMES) {
            await expect(teamCards.nth(0).getByText(name, { exact: true })).toBeVisible();
        }
        for (const name of AXIS_NAMES) {
            await expect(teamCards.nth(1).getByText(name, { exact: true })).toBeVisible();
        }

        // ── Checkpoint 2: Flags initialized ─────────────────────────
        await waitForFlags(page);
        await takeScreenshot(page, '02-flags-init');
        await expect(page.locator('.flag-item')).toHaveCount(5);

        // ── Checkpoint 3: Round started + Score visible ─────────────
        await page.waitForSelector('.timer-area span', { timeout: 15_000 });
        await takeScreenshot(page, '03-round-started');

        // Score should be 0-0
        await expect(page.locator('.allies-score')).toHaveText('0');
        await expect(page.locator('.axis-score')).toHaveText('0');

        // ── Checkpoint 4: Prone shame visible on ian ────────────────
        // prone_change fires at 6s — wait for .card-prone to appear
        await page.waitForSelector('.card-prone', { timeout: 20_000 });
        await takeScreenshot(page, '04-prone-shame');

        // ── Checkpoint 5: Kill feed with first kills ────────────────
        // First kill at 9s, second at 10s. Kill items expire after 5s.
        await waitForKillFeed(page, 1, 20_000);
        await takeScreenshot(page, '05-kill-feed');
        await expect(page.locator('.wrapper .kill').first()).toBeVisible();

        // ── Checkpoint 6: Flag capture ───────────────────────────────
        // dod_anzio mocker starts all 5 flags neutral; allies cap Anzio Street at 15s
        // → exactly one .flag-allies appears.
        await page.waitForFunction(
            () => document.querySelectorAll('.flag-item.flag-allies').length >= 1,
            { timeout: 25_000 },
        );
        await takeScreenshot(page, '06-flag-captured');

        // ── Checkpoint 7: Scores updated ─────────────────────────────
        // player_score events fire at 15.1s — check K/D display changed
        await page.waitForFunction(
            () => {
                const cards = document.querySelectorAll('.bottom-bar .team-cards');
                if (cards.length < 1) return false;
                const kills = cards[0].querySelectorAll('.card-kills');
                return Array.from(kills).some(el => el.textContent !== '0');
            },
            { timeout: 25_000 },
        );
        await takeScreenshot(page, '07-scores-updated');

        // ── Checkpoint 7b: Mid-round tick scoring (~25.5s) ───────────
        // Bug A regression guard: tick scoring fires team_score broadcasts
        // every ~10-20s for held flags. The plugin previously read from DODX's
        // message-tracked globals which sit at 0 in extension mode, dropping
        // every tick silently. With dodx_get_team_score (gamerules direct),
        // ticks land. Mocker fires a tick at t=25500 bumping allies to 2.
        await page.waitForFunction(
            () => document.querySelector('.allies-score')?.textContent === '2',
            { timeout: 30_000 },
        );
        await expect(page.locator('.axis-score')).toHaveText('0');
        await takeScreenshot(page, '07b-tick-scoring');

        // ── Checkpoint 8: Round end (30s) — cumulative 2-0 ──────────
        await page.waitForFunction(
            () => {
                const allies = document.querySelector('.allies-score')?.textContent;
                const axis   = document.querySelector('.axis-score')?.textContent;
                return allies === '2' && axis === '0';
            },
            { timeout: 45_000 },
        );
        await takeScreenshot(page, '08-round-end');

        // ── Checkpoint 9: Round 2 starts (38s) ──────────────────────
        // All players respawn — no .dead elements
        await page.waitForFunction(
            () => {
                const dead = document.querySelectorAll('.bottom-bar .player-card.dead');
                return dead.length === 0;
            },
            { timeout: 55_000 },
        );
        await takeScreenshot(page, '09-round2-started');

        // ── Checkpoint 10: Half-1 ends 2-1 (~55s) ────────────────────
        // round_end at t=55000 sets allies=2, axis=1 (1 cap + 1 tick for
        // allies in round 1, 1 cap for axis in round 2 = cumulative 2-1).
        await page.waitForFunction(
            () => document.querySelector('.allies-score')?.textContent === '2'
               && document.querySelector('.axis-score')?.textContent === '1',
            { timeout: 60_000 },
        );
        await takeScreenshot(page, '10-half1-end');

        // ── Checkpoint 11: Half 2 starts — score carries over ───────
        // Bug 2 regression guard: at half_start (62s), the old code zeroed
        // team scores in resetHalf(), so the HUD would briefly show 0-0 until
        // the next round_end. Now the plugin's post–half_start team_score
        // (mocker fires it at 62050ms) seeds the carryover. The score must
        // never dip to 0 across the half-time boundary.
        //
        // We sample the score continuously while waiting for the half-2 team
        // swap to land — that's the unambiguous signal we've crossed half_start
        // (at t=62000) AND the player_team_change events (at t=62100).
        const seenScores: string[] = [];
        const watchSampler = setInterval(async () => {
            const allies = await page.locator('.allies-score').textContent().catch(() => null);
            const axis   = await page.locator('.axis-score').textContent().catch(() => null);
            if (allies != null && axis != null) seenScores.push(`${allies}-${axis}`);
        }, 50);

        // Wait for the team swap: 'mogers' (STEAM 2001) was on Axis in half 1
        // and moves to Allies in half 2. The first team-cards row is allies.
        await page.waitForFunction(
            () => {
                const cards = document.querySelectorAll('.bottom-bar .team-cards');
                if (cards.length < 1) return false;
                return !!cards[0].querySelector(':scope *')?.textContent?.includes('mogers');
            },
            { timeout: 30_000 },
        );
        clearInterval(watchSampler);

        // Score should never have flipped back to 0-0 once we hit 2-1 — that
        // would mean resetHalf zeroed scores at half_start, which is the bug.
        const sawCarryover = seenScores.indexOf('2-1');
        expect(sawCarryover).toBeGreaterThanOrEqual(0);
        const zeroedAfter = seenScores.slice(sawCarryover).some(s => s === '0-0');
        expect(zeroedAfter).toBe(false);

        // Live score at screenshot moment is still the cumulative 2-1 carryover.
        await expect(page.locator('.allies-score')).toHaveText('2');
        await expect(page.locator('.axis-score')).toHaveText('1');

        await takeScreenshot(page, '11-half2-carryover');
    });
});
