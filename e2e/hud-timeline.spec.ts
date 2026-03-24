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

        // ── Checkpoint 4: Caster observing Raphinha ─────────────────
        // Observed player bar appears at bottom center
        await page.waitForSelector('.player-observed', { timeout: 15_000 });
        await expect(page.locator('.player-observed .observed-name')).toContainText('Raphinha');
        await takeScreenshot(page, '04-observed-player');

        // ── Checkpoint 5: Prone shame visible on ian ────────────────
        // prone_change fires at 6s — wait for .card-prone to appear
        await page.waitForSelector('.card-prone', { timeout: 20_000 });
        await takeScreenshot(page, '05-prone-shame');

        // ── Checkpoint 6: Kill feed with first kills ────────────────
        // First kill at 9s, second at 10s. Kill items expire after 5s.
        await waitForKillFeed(page, 1, 20_000);
        await takeScreenshot(page, '06-kill-feed');
        await expect(page.locator('.wrapper .kill').first()).toBeVisible();

        // ── Checkpoint 7: Flag capture ───────────────────────────────
        // Allies capture Church at 15s → two .flag-allies (Allied Base + Church)
        await page.waitForFunction(
            () => document.querySelectorAll('.flag-item.flag-allies').length >= 2,
            { timeout: 25_000 },
        );
        await takeScreenshot(page, '07-flag-captured');

        // ── Checkpoint 8: Scores updated ─────────────────────────────
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
        await takeScreenshot(page, '08-scores-updated');

        // ── Checkpoint 9: Round end (30s) ────────────────────────────
        // Score changes to 1-0 Allies
        await page.waitForFunction(
            () => {
                const el = document.querySelector('.allies-score');
                return el && el.textContent === '1';
            },
            { timeout: 45_000 },
        );
        await expect(page.locator('.axis-score')).toHaveText('0');
        await takeScreenshot(page, '09-round-end');

        // ── Checkpoint 10: Round 2 starts (38s) ─────────────────────
        // All players respawn — no .dead elements
        await page.waitForFunction(
            () => {
                const dead = document.querySelectorAll('.bottom-bar .player-card.dead');
                return dead.length === 0;
            },
            { timeout: 55_000 },
        );
        await takeScreenshot(page, '10-round2-started');
    });
});
