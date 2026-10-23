import { expect, test } from '@playwright/test';
import { openShop, slowStep } from './app';

test('lists three products @smoke', async ({ page }) => {
    await openShop(page);
    await slowStep(page, 5);
    await expect(page.locator('#products li')).toHaveCount(3);
});

test('shows the shop heading', async ({ page }) => {
    await openShop(page);
    await slowStep(page, 5);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Demo Shop');
});

// Intentionally failing so the MCP server's failure reporting can be demonstrated.
// Exclude it with grepInvert "@failing".
test('applies a discount code @failing', async ({ page }) => {
    await openShop(page);
    await slowStep(page, 3);
    await expect(page.getByPlaceholder('Discount code')).toBeVisible({ timeout: 2000 });
});
