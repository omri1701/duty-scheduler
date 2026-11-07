import {test, expect} from './fixtures';
import type {Page} from '@playwright/test';

// The iPhone status bar / notch area (owner test 2026-11-07): it follows every theme change, and at
// rest nothing sits blurred under it. data-safe-area=test gives the iPhone insets (59px top).
const LIGHT = '#f2f3f5', DARK = '#000000';
const metas = (page: Page) => page.locator('meta[name="theme-color"]').evaluateAll(list => list.map(m => m.getAttribute('content')));
const strip = (page: Page) => page.locator('.safe-top').evaluate(el => getComputedStyle(el).backgroundColor);
async function expectNotch(page: Page, color: string) {
  await expect.poll(() => metas(page)).toEqual([color]);
  await expect.poll(() => strip(page)).toBe(color === DARK ? 'rgb(0, 0, 0)' : 'rgb(242, 243, 245)');
}

test('the notch colour follows Light, Dark and Auto, including a device change in Auto', async ({page, openApp}) => {
  await page.emulateMedia({colorScheme: 'light'});
  await openApp();
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  const sheet = page.getByRole('dialog', {name: 'Settings'});
  await sheet.getByRole('radio', {name: 'Dark', exact: true}).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expectNotch(page, DARK);
  await sheet.getByRole('radio', {name: 'Light', exact: true}).check();
  await expectNotch(page, LIGHT);
  // Auto: the device decides, and a device change recolours the notch without touching Settings.
  await page.emulateMedia({colorScheme: 'dark'});
  await expectNotch(page, LIGHT);
  await sheet.getByRole('radio', {name: 'Auto', exact: true}).check();
  await expectNotch(page, DARK);
  await page.emulateMedia({colorScheme: 'light'});
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expectNotch(page, LIGHT);
  await page.emulateMedia({colorScheme: 'dark'});
  await expectNotch(page, DARK);
  // A saved choice colours the notch before the first paint (THEME_SCRIPT), against the device.
  await page.addInitScript(() => localStorage.setItem('duty-theme', 'light'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expectNotch(page, LIGHT);
});

for (const scheme of ['light', 'dark'] as const) test(`at rest the top is solid and clear on a notched phone ${scheme}`, async ({page, openApp}) => {
  test.skip(test.info().project.name !== 'mobile', 'phone layout');
  await page.emulateMedia({colorScheme: scheme});
  await openApp();
  await page.evaluate(() => {document.documentElement.dataset.safeArea = 'test';});
  for (const tab of ['Home', 'Schedule']) {
    await page.getByRole('tab', {name: tab, exact: true}).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    const top = await page.evaluate(() => {
      const sat = 59, strip = document.querySelector('.safe-top')!.getBoundingClientRect();
      const css = getComputedStyle(document.querySelector('.safe-top')!);
      // Everything visible near the top: nothing may start inside the status bar or its soft edge (sat + 12px),
      // and nothing there may carry a backdrop blur at rest.
      const clash = [...document.querySelectorAll('main *, header *')].filter(el => {
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && r.top < sat + 12 && r.bottom > 0;
      }).map(el => el.className || el.tagName);
      const blurred = [...document.querySelectorAll('body *')].filter(el => {
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        return r.top < sat + 12 && r.bottom > 0 && r.width > 0 && /blur/.test(s.backdropFilter + s.filter);
      }).map(el => el.className || el.tagName);
      return {stripTop: strip.top, stripHeight: strip.height, opaque: css.backgroundColor.startsWith('rgb('), z: +css.zIndex, clash, blurred};
    });
    expect(top).toEqual({stripTop: 0, stripHeight: 59, opaque: true, z: 60, clash: [], blurred: []});
  }
});
