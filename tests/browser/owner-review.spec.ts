import type {Page} from '@playwright/test';
import {test, expect, ids, touchEvent, switchLanguage} from './fixtures';

// Owner review of PR #78 (2026-11-07): month heading swipe, refresh, sidebar, Home on PC,
// balances kept while loading, readable menu highlights.
const tab = (page: Page, name: string) => page.getByRole('tab', {name, exact: true}).click();
const title = (page: Page) => page.locator('.month-title:visible .month-name');

for (const lang of ['en', 'he'] as const) test(`dragging the month heading changes month in reading direction ${lang}`, async ({page, openApp}) => {
  await openApp();
  if (lang === 'he') await switchLanguage(page, 'he');
  await tab(page, lang === 'en' ? 'Schedule' : 'לוח');
  const start = await title(page).textContent();
  const box = (await page.locator('.month-title:visible h2').boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  // A drag toward the reading start moves forward: left in English, right in Hebrew.
  const forward = lang === 'en' ? -1 : 1;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + forward * 90, y, {steps: 6}); await page.mouse.up();
  await expect(title(page)).not.toHaveText(start!);
  await expect(page.locator('.calendar-grid [data-date]').first()).toHaveAttribute('data-date', '2026-11-29');
  // A short drag springs back without changing month.
  const next = await title(page).textContent();
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + forward * 20, y, {steps: 3}); await page.mouse.up();
  await expect(title(page)).toHaveText(next!);
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x - forward * 90, y, {steps: 6}); await page.mouse.up();
  await expect(title(page)).toHaveText(start!);
});

test('the logo refreshes the team with a spinner and nothing shifts', async ({page, openApp, backend}) => {
  await openApp();
  const loads = () => backend.calls.filter(c => c.name === 'duty_load').length, before = loads();
  const header = await page.locator('.hdr').boundingBox();
  let release!: () => void;
  const held = new Promise<void>(resolve => {release = resolve;});
  await page.route('**/rest/v1/rpc/duty_load', async route => {await held; await route.fallback();});
  await page.getByRole('button', {name: /Refresh/}).first().click();
  await expect(page.locator('.refresh-indicator')).toHaveAttribute('data-state', 'refreshing');
  release();
  await expect.poll(loads).toBe(before + 1);
  await expect(page.locator('.refresh-indicator')).toHaveAttribute('data-state', 'idle');
  expect(await page.locator('.hdr').boundingBox()).toEqual(header);
});

test('pulling down at the top of a phone screen refreshes; a short pull does not', async ({page, openApp, backend}, info) => {
  test.skip(info.project.name !== 'mobile', 'Touch pull.');
  await openApp();
  const loads = () => backend.calls.filter(c => c.name === 'duty_load').length, before = loads();
  const at = {x: 195, y: 200};
  await touchEvent(page, 'touchstart', at.x, at.y); await touchEvent(page, 'touchmove', at.x, at.y + 40); await touchEvent(page, 'touchend', at.x, at.y + 40);
  await page.waitForTimeout(300);
  expect(loads()).toBe(before);
  await touchEvent(page, 'touchstart', at.x, at.y);
  for (const dy of [30, 90, 160, 220]) await touchEvent(page, 'touchmove', at.x, at.y + dy);
  await expect(page.locator('.refresh-indicator')).toHaveAttribute('data-ready', 'true');
  await touchEvent(page, 'touchend', at.x, at.y + 220);
  await expect.poll(loads).toBe(before + 1);
  await expect(page.locator('.refresh-indicator')).toHaveAttribute('data-state', 'idle');
});

test('the PC sidebar folds to icons with tooltips and remembers it', async ({page, openApp}, info) => {
  test.skip(info.project.name !== 'desktop', 'PC sidebar.');
  await openApp();
  const side = page.locator('.side'), toggle = page.getByRole('button', {name: 'Collapse sidebar'});
  expect((await side.boundingBox())!.width).toBe(232);
  await toggle.click();
  await expect.poll(async () => (await side.boundingBox())!.width).toBe(72);
  await expect(page.getByRole('button', {name: 'Expand sidebar'})).toHaveAttribute('aria-expanded', 'false');
  const team = page.getByRole('tab', {name: 'Team', exact: true});
  await team.hover();
  await expect(team.locator('.navigation-label')).toHaveCSS('opacity', '1');
  expect(await page.evaluate(() => localStorage.getItem('duty-sidebar'))).toBe('collapsed');
  // The fixture clears storage on every load; put the saved choice back to test the pre-paint script.
  await page.addInitScript(() => localStorage.setItem('duty-sidebar', 'collapsed'));
  await page.reload();
  await expect(page.getByRole('button', {name: 'Expand sidebar'})).toBeVisible();
  expect((await side.boundingBox())!.width).toBe(72);
  await page.getByRole('button', {name: 'Expand sidebar'}).click();
  await expect.poll(async () => (await side.boundingBox())!.width).toBe(232);
});

test('Home on PC steps through the next duties with arrows and clickable dots', async ({page, openApp, backend}, info) => {
  test.skip(info.project.name !== 'desktop', 'PC layout; phones swipe.');
  backend.raw.months[0].status = 'published';
  await openApp('a');
  const cards = page.locator('.hero-track > .hero'), current = page.locator('.hero-track > .hero[aria-current=true]');
  await expect(current).toContainText('2 November');
  // Owner round 2: no extra row of small cards, only the arrows and dots.
  await expect(page.locator('.hero-next')).toHaveCount(0);
  expect(await cards.count()).toBeGreaterThan(2);
  await page.getByRole('button', {name: 'Next duty'}).click();
  await expect(current).toContainText('9 November');
  await expect(page.getByRole('button', {name: 'Previous duty'})).toBeEnabled();
  await page.getByRole('button', {name: /^Duty 1 of/}).click();
  await expect(current).toContainText('2 November');
  await page.getByRole('button', {name: /^Duty 3 of/}).click();
  await expect(current).toContainText('16 November');
});

test('Team keeps the last known balances on screen while a newer one loads', async ({page, openApp, backend}) => {
  backend.balance = {net: {[ids.admin]: 2, [ids.a]: -2, [ids.b]: 0, [ids.c]: 0, [ids.d]: 0, [ids.e]: 0}, lines: []} as unknown as typeof backend.balance;
  await openApp();
  await tab(page, 'Team');
  const net = page.locator(`[data-member="${ids.admin}"] .net-points strong`);
  await expect(net).toHaveText('+1');
  // The next read is held: going away and back, the number never disappears.
  let release!: () => void;
  const held = new Promise<void>(resolve => {release = resolve;});
  await page.route('**/rest/v1/rpc/duty_balance', async route => {await held; await route.fallback();});
  backend.raw.revision!++;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await tab(page, 'Home'); await tab(page, 'Team');
  await expect(net).toHaveText('+1');
  backend.balance = {net: {[ids.admin]: 4, [ids.a]: -4, [ids.b]: 0, [ids.c]: 0, [ids.d]: 0, [ids.e]: 0}, lines: []} as unknown as typeof backend.balance;
  release();
  await expect(net).toHaveText('+2');
});

for (const scheme of ['light', 'dark'] as const) test(`menu and picker highlights are readable in ${scheme}`, async ({page, openApp}) => {
  await page.emulateMedia({colorScheme: scheme});
  await openApp();
  await tab(page, 'Availability');
  await page.getByRole('combobox', {name: 'Engineer'}).click();
  const option = page.getByRole('option').nth(1);
  await option.hover();
  await expect(option).toHaveAttribute('data-highlighted', '');
  const ratio = await option.evaluate(el => {
    const rgb = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    const lum = ([r, g, b]: number[]) => {const c = [r, g, b].map(v => {v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;}); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2];};
    const css = getComputedStyle(el), [a, b] = [lum(rgb(css.color)), lum(rgb(css.backgroundColor))];
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  });
  expect(ratio).toBeGreaterThanOrEqual(7);
  await page.keyboard.press('Escape');
});
