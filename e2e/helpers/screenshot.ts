import { Page } from '@playwright/test';
import * as path from 'path';

const SNAPSHOTS_DIR = path.join(__dirname, '..', 'snapshots');

/**
 * Takes a 1920x1080 screenshot and saves it to e2e/snapshots/{name}.png.
 * Returns the absolute file path so it can be read/inspected.
 */
export async function takeScreenshot(page: Page, name: string): Promise<string> {
    const filePath = path.join(SNAPSHOTS_DIR, `${name}.png`);
    await page.screenshot({ path: filePath, fullPage: false });
    return filePath;
}
