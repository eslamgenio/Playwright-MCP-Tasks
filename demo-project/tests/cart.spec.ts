import { expect, test } from '@playwright/test';
import { openShop, slowStep } from './app';

test.describe('cart', () => {
    test('starts empty', async ({ page }) => {
        await openShop(page);
        await slowStep(page, 4);
        await expect(page.locator('#count')).toHaveText('0');
    });

    test('adds a single product', async ({ page }) => {
        await openShop(page);
        await slowStep(page, 8);
        await page.getByRole('listitem').filter({ hasText: 'Mug' }).getByRole('button').click();
        await expect(page.locator('#total')).toHaveText('12');
    });

    test('adds every product', async ({ page }) => {
        await openShop(page);
        for (const button of await page.locator('#products button').all()) {
            await slowStep(page, 3);
            await button.click();
        }
        await expect(page.locator('#count')).toHaveText('3');
        await expect(page.locator('#total')).toHaveText('45');
    });

    test('adds the same product twice', async ({ page }) => {
        await openShop(page);
        const add = page.getByRole('listitem').filter({ hasText: 'T-shirt' }).getByRole('button');
        await add.click();
        await slowStep(page, 7);
        await add.click();
        await expect(page.locator('#total')).toHaveText('50');
    });
});
