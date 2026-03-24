import { Page } from '@playwright/test';

/**
 * Wait until at least `alliesCount` allied players and `axisCount` axis players
 * are rendered with visible names in the HUD.
 */
export async function waitForPlayers(page: Page, alliesCount: number, axisCount: number, timeout = 30_000) {
    await page.waitForFunction(
        ({ allies, axis }) => {
            const cards = document.querySelectorAll('.bottom-bar .team-cards');
            if (cards.length < 2) return false;

            const leftNames = cards[0].querySelectorAll('.card-name');
            const rightNames = cards[1].querySelectorAll('.card-name');

            const leftWithText = Array.from(leftNames).filter(el => el.textContent && el.textContent.trim().length > 0);
            const rightWithText = Array.from(rightNames).filter(el => el.textContent && el.textContent.trim().length > 0);

            return leftWithText.length >= allies && rightWithText.length >= axis;
        },
        { allies: alliesCount, axis: axisCount },
        { timeout },
    );
}

/**
 * Wait until the kill feed has at least `minCount` visible kill entries.
 * Kill items are `.kill` elements inside `.wrapper`.
 */
export async function waitForKillFeed(page: Page, minCount: number, timeout = 30_000) {
    await page.waitForFunction(
        (min) => {
            const kills = document.querySelectorAll('.wrapper .kill');
            // Filter out kills that only contain an empty div (expired items return <div/>)
            const visible = Array.from(kills).filter(el => el.children.length > 1 || el.textContent!.trim().length > 0);
            return visible.length >= min;
        },
        minCount,
        { timeout },
    );
}

/**
 * Wait until the flags container renders with at least one flag item.
 */
export async function waitForFlags(page: Page, timeout = 30_000) {
    await page.waitForSelector('.flags-container .flag-item', { timeout });
}
