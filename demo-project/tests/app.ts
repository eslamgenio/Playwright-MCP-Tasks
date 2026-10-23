import type { Page } from '@playwright/test';

/** A tiny offline "shop" rendered with page.setContent, so the demo needs no server or network. */
export async function openShop(page: Page) {
    await page.setContent(`
        <h1>Demo Shop</h1>
        <form id="login">
            <input name="user" placeholder="User" />
            <input name="password" type="password" placeholder="Password" />
            <button type="submit">Sign in</button>
        </form>
        <p id="welcome" hidden></p>
        <ul id="products">
            <li data-price="12">Mug <button>Add</button></li>
            <li data-price="25">T-shirt <button>Add</button></li>
            <li data-price="8">Sticker pack <button>Add</button></li>
        </ul>
        <p>Cart: <span id="count">0</span> items, total $<span id="total">0</span></p>
        <script>
            document.getElementById('login').addEventListener('submit', e => {
                e.preventDefault();
                const user = new FormData(e.target).get('user');
                const welcome = document.getElementById('welcome');
                welcome.textContent = 'Welcome, ' + user + '!';
                welcome.hidden = false;
            });
            let count = 0, total = 0;
            for (const li of document.querySelectorAll('#products li')) {
                li.querySelector('button').addEventListener('click', () => {
                    count++;
                    total += Number(li.dataset.price);
                    document.getElementById('count').textContent = count;
                    document.getElementById('total').textContent = total;
                });
            }
        </script>`);
}

/** Simulates a slow backend so the suite takes long enough to watch as an MCP task. */
export async function slowStep(page: Page, seconds: number) {
    await page.waitForTimeout(seconds * 1000);
}
