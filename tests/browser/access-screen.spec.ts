import type {Page} from '@playwright/test';
import {test, expect, ids, type Backend} from './fixtures';

// The sign-in screen (owner round 4, 2026-11-07): centred on phone and PC, its states too; one
// main button; a language switch in the corner that works before sign-in, survives the Google
// round trip and becomes the member's language; the phone keyboard never re-centres it.
const local = (backend: Backend) => {backend.url = 'http://127.0.0.1:54321'; backend.runtimeOrigin = 'http://localhost:8787';};
async function centring(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector('.access-page')!, stack = document.querySelector('.access-stack')!.getBoundingClientRect();
    const css = getComputedStyle(main), top = parseFloat(css.paddingTop), bottom = parseFloat(css.paddingBottom), box = main.getBoundingClientRect();
    return {dx: stack.x + stack.width / 2 - innerWidth / 2, dy: stack.y + stack.height / 2 - (box.y + top + (box.height - top - bottom) / 2),
      overflow: document.documentElement.scrollWidth - innerWidth, buttons: document.querySelectorAll('.access-card .access-main').length};
  });
}

for (const identity of ['signed-out', 'pending', 'rejected', 'inactive'] as const) for (const lang of ['en', 'he'] as const) test(`the ${identity} screen is centred with one main button ${lang}`, async ({page, openApp}) => {
  await openApp(identity);
  if (lang === 'he') await page.getByRole('button', {name: 'עברית', exact: true}).click();
  await expect(page.locator('.access-page')).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
  await expect(page.locator('.access-hero')).toContainText(lang === 'he' ? 'לוח התורנויות של הצוות' : 'Your team’s duty rota');
  const c = await centring(page);
  expect(Math.abs(c.dx), 'horizontally centred').toBeLessThanOrEqual(1);
  expect(Math.abs(c.dy), 'vertically centred').toBeLessThanOrEqual(1);
  expect(c.overflow).toBe(0);
  expect(c.buttons, 'one main button').toBe(1);
});

test('the language picked before sign-in survives the round trip and becomes the member’s language', async ({page, openApp, backend}) => {
  local(backend);
  await openApp('signed-out');
  await page.getByRole('button', {name: 'עברית', exact: true}).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', {level: 1})).toHaveText('לוח התורנויות של הצוות');
  await expect(page.getByRole('button', {name: 'עברית', exact: true})).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => localStorage.getItem('duty-sign-in-language'))).toBe('he');
  // The fixture clears storage on every load; a real browser keeps it across the Google redirect.
  await page.addInitScript(() => localStorage.setItem('duty-sign-in-language', 'he'));
  await page.reload();
  await expect(page.locator('.access-page')).toHaveAttribute('dir', 'rtl');
  await page.locator('input[type=password]').fill('synthetic-only');
  await page.locator('form.local-login button[type=submit]').click();
  await expect(page.locator('[data-settings-button]')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'he');
  await expect.poll(() => backend.languages.get(ids.admin)).toBe('he');
});

test('the phone keyboard does not re-centre the sign-in form', async ({page, openApp, backend}, info) => {
  test.skip(info.project.name !== 'mobile', 'Phone keyboard.');
  local(backend);
  await openApp('signed-out');
  const where = () => page.locator('.access-stack').evaluate(e => e.getBoundingClientRect().top + scrollY);
  const before = await where();
  await page.locator('input[type=password]').focus();
  // The keyboard resizes the viewport (interactive-widget=resizes-content).
  await page.setViewportSize({width: 390, height: 480});
  await page.waitForTimeout(100);
  expect(Math.abs(await where() - before)).toBeLessThanOrEqual(1);
  const input = page.locator('input[type=password]');
  await input.scrollIntoViewIfNeeded();
  const box = (await input.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(480);
  // Closing it gives the page its full height back, centred again.
  await page.locator('input[type=password]').blur();
  await page.setViewportSize({width: 390, height: 844});
  await expect.poll(async () => Math.abs((await centring(page)).dy)).toBeLessThanOrEqual(1);
});
