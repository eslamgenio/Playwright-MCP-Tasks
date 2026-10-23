import { expect, test } from '@playwright/test';
import { openShop, slowStep } from './app';

test.describe('login', () => {
    for (const user of ['alice', 'bob', 'carol']) {
        test(`signs in as ${user} @smoke`, async ({ page }) => {
            await openShop(page);
            await slowStep(page, 6);
            await page.getByPlaceholder('User').fill(user);
            await page.getByPlaceholder('Password').fill('secret');
            await page.getByRole('button', { name: 'Sign in' }).click();
            await expect(page.locator('#welcome')).toHaveText(`Welcome, ${user}!`);
        });
    }
});
