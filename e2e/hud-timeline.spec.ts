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
        // Single flag caps no longer trigger a stats popup — the flag feed
        // announces them, cumulative stats appear on the capout/half/match boards.
        await expect(page.locator('.capstats-item')).toHaveCount(0);

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

        // ── Checkpoint 7a: Kill-feed assist (~18s) ───────────────────
        // "bad" finishes bud after "E t" dealt 55 damage — the kill event
        // carries assist_ids and the feed renders "bad + E t".
        await page.waitForSelector('.kill-assist-name', { timeout: 15_000 });
        await expect(page.locator('.kill-assist-name').first()).toHaveText('E t');
        await takeScreenshot(page, '07a-kill-assist');

        // ── Checkpoint 7a2: Teamkill count in kill feed (~21.8s) ─────
        // Polak TKs twice; the second feed entry shows his running count "TK ×2".
        await page.waitForFunction(
            () => Array.from(document.querySelectorAll('.kill-tk-badge'))
                .some(el => el.textContent?.replace(/\s/g, '') === 'TK×2'),
            { timeout: 15_000 },
        );
        // Invariant: a teamkill row never shows a kill-streak badge (the streak
        // is gated on !isTeamkill so a TK can't read as a streak kill).
        await expect(page.locator('.kill', { has: page.locator('.kill-tk-badge') })
            .locator('.kill-streak-badge')).toHaveCount(0);
        await takeScreenshot(page, '07a2-teamkill-count');

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

        // ── Checkpoint 10b: Halftime stats board (~57s) ──────────────
        // half_end + player_stats_summary(half_end) fire at 57s; the centered
        // board auto-shows with 6 rows per team (tbody), sorted by damage desc,
        // plus a team-totals tfoot row and the round-score header.
        await page.waitForSelector('.stats-board', { timeout: 15_000 });
        await expect(page.locator('.stats-board-title')).toHaveText('HALFTIME STATS');
        await expect(page.locator('.stats-board-allies tbody tr')).toHaveCount(6);
        await expect(page.locator('.stats-board-axis tbody tr')).toHaveCount(6);
        // No team-score line on the board — the top score bar already shows it.
        await expect(page.locator('.stats-board-score')).toHaveCount(0);
        // New columns present.
        await expect(page.locator('.stats-board-axis thead').getByText('CAP')).toBeVisible();
        await expect(page.locator('.stats-board-axis thead').getByText('STK')).toBeVisible();
        // Damage-desc ordering + MVP: mogers (397 DMG) tops the axis column and
        // is flagged MVP; his best streak (STK, last col) reads 4.
        const mogersHalf = page.locator('.stats-board-axis tbody tr').first();
        await expect(mogersHalf.locator('.stats-board-player-col')).toContainText('mogers');
        await expect(mogersHalf).toHaveClass(/stats-board-mvp/);
        await expect(mogersHalf.locator('td').last()).toHaveText('4');
        // Team totals footer present.
        await expect(page.locator('.stats-board-axis tfoot .stats-board-totals')).toBeVisible();
        await takeScreenshot(page, '10b-halftime-board');

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

        // The halftime board is dismissed when half 2 goes live (half_start
        // boundary handling) — regression guard against it lingering over play.
        await expect(page.locator('.stats-board')).toHaveCount(0);

        await takeScreenshot(page, '11-half2-carryover');

        // ── Checkpoint 12: Capout board (~73.3s) ─────────────────────
        // Allies sweep all 5 flags in H2 → player_stats_summary(round_end).
        // The cumulative capout board shows half-2-so-far stats with a CAPOUT
        // title and the bumped 3-1 score.
        await page.waitForSelector('.stats-board-reason-round_end', { timeout: 25_000 });
        // Title names the capping team + who swept the last flag (omenator capped
        // the final flag, Anzio Laundry).
        await expect(page.locator('.stats-board-title')).toHaveText('ALLIES CAPOUT BY omenator');
        await expect(page.locator('.stats-board-score')).toHaveCount(0);
        // mogers (now allies) led the sweep with 2 caps — CAP column (2nd from last).
        const mogersCapout = page.locator('.stats-board-allies tbody tr').first();
        await expect(mogersCapout.locator('.stats-board-player-col')).toContainText('mogers');
        await expect(mogersCapout.locator('td').nth(7)).toHaveText('2');
        await takeScreenshot(page, '12-capout-board');

        // ── Checkpoint 13: Final stats board (~77s) ──────────────────
        // player_stats_summary(match_end) shows FINAL STATS with full-match
        // totals: half-1 carryover (from the half_end summary) + half-2 rows.
        await page.waitForSelector('.stats-board-reason-match_end', { timeout: 25_000 });
        await expect(page.locator('.stats-board-title')).toHaveText('FINAL STATS');
        await expect(page.locator('.stats-board-score')).toHaveCount(0);
        // mogers: 4 kills in half 1 + 1 in half 2 = 5 cumulative (now on allies
        // after the side swap); caps 1 (H1) + 2 (H2 sweep) = 3.
        const mogersFinal = page.locator('.stats-board-allies tbody tr')
            .filter({ has: page.getByText('mogers') });
        await expect(mogersFinal.locator('td').nth(1)).toHaveText('5');
        await expect(mogersFinal.locator('td').nth(7)).toHaveText('3');
        await takeScreenshot(page, '13-final-board');
    });
});
