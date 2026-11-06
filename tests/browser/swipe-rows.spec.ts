import type {Page} from '@playwright/test';
import {test, expect, ids, switchLanguage} from './fixtures';

// Swipes with real touch input (CDP), as a phone sends them (owner round 2, 2026-11-07): Team rows
// deactivate and activate, swap cards answer, bell items and toasts dismiss.
async function touchSwipe(page: Page, x: number, y: number, dx: number) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', px: number) => cdp.send('Input.dispatchTouchEvent', {type, touchPoints: type === 'touchEnd' ? [] : [{x: px, y}]});
  await send('touchStart', x);
  for (let step = 1; step <= 10; step++) await send('touchMove', x + dx * step / 10);
  await send('touchEnd', x + dx);
  await cdp.detach();
}
const centre = async (page: Page, selector: string, at = .5) => {const b = (await page.locator(selector).boundingBox())!; return {x: b.x + b.width * at, y: b.y + b.height / 2};};

for (const lang of ['en', 'he'] as const) test(`a touch swipe on a Team row deactivates, then activates ${lang}`, async ({page, openApp, backend}, info) => {
  test.skip(info.project.name !== 'mobile', 'Phone touch.');
  await openApp();
  if (lang === 'he') await switchLanguage(page, 'he');
  await page.getByRole('tab').nth(3).click();
  const row = `[data-member="${ids.b}"]`, toward = lang === 'he' ? 1 : -1;
  // A short swipe reveals the action; tapping it deactivates.
  let at = await centre(page, `${row} .swipe-content`, .5);
  await touchSwipe(page, at.x, at.y, toward * 110);
  await expect(page.locator(row)).toHaveClass(/swipe-open/);
  await page.locator(`${row} .swipe-action`).click();
  await expect(page.locator(row)).toHaveClass(/inactive/);
  await expect.poll(() => backend.raw.members.find(m => m.id === ids.b)!.active).toBe(false);
  // A long swipe on the inactive row activates it at once.
  at = await centre(page, `${row} .swipe-content`, .5);
  await touchSwipe(page, at.x, at.y, toward * 260);
  await expect.poll(() => backend.raw.members.find(m => m.id === ids.b)!.active).toBe(true);
});

test('a second tap on the selected phone day clears it', async ({page, openApp}, info) => {
  test.skip(info.project.name !== 'mobile', 'Phone day details.');
  await openApp();
  await page.getByRole('tab', {name: 'Schedule', exact: true}).click();
  const cell = page.locator('button[data-date="2026-11-03"]').filter({has: page.locator('.date-line')});
  await cell.click();
  await expect(page.locator('[data-day-details]')).toBeVisible();
  await expect(cell).toHaveClass(/selected-day/);
  await cell.click();
  await expect(page.locator('[data-day-details]')).toHaveCount(0);
  await expect(cell).not.toHaveClass(/selected-day/);
});

const month = (page: Page) => page.locator('.month-title:visible .month-name');
for (const lang of ['en', 'he'] as const) test(`the calendar follows a sideways swipe to the next month and springs back on a short one ${lang}`, async ({page, openApp}, info) => {
  await openApp();
  if (lang === 'he') await switchLanguage(page, 'he');
  await page.getByRole('tab', {name: lang === 'en' ? 'Schedule' : 'לוח', exact: true}).click();
  const start = await month(page).textContent(), toward = lang === 'he' ? 1 : -1;
  const grid = (await page.locator('.calendar-grid').boundingBox())!, head = (await page.locator('.calendar-weekdays:visible').boundingBox())!;
  // The weekday row: no duty there, so a mouse drag belongs to the month.
  const y = info.project.name === 'mobile' ? grid.y + 20 : head.y + head.height / 2;
  const x = grid.x + grid.width / 2;
  if (info.project.name === 'mobile') {
    await touchSwipe(page, x, y, toward * 40);
    await expect(month(page)).toHaveText(start!);
    await touchSwipe(page, x, y, toward * 220);
  } else {
    // A mouse drag from the weekday row (no duty there) turns the page too.
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + toward * 40, y, {steps: 4}); await page.mouse.up();
    await expect(month(page)).toHaveText(start!);
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + toward * grid.width * .6, y, {steps: 8}); await page.mouse.up();
  }
  await expect(month(page)).not.toHaveText(start!);
  await expect(page.locator('.calendar-grid [data-date]').first()).toHaveAttribute('data-date', '2026-11-29');
  await expect(page.locator('.month-peek')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('the chevrons play the same transition with the neighbour month sliding in', async ({page, openApp}) => {
  await page.emulateMedia({reducedMotion: 'no-preference'});
  await openApp();
  await page.getByRole('tab', {name: 'Schedule', exact: true}).click();
  await page.getByRole('button', {name: 'Next month', exact: true}).click();
  await expect(page.locator('.month-peek')).toHaveCount(1);
  await expect(page.locator('.month-peek')).toContainText('31');
  await expect(month(page)).toHaveText('December 2026');
  await expect(page.locator('.month-peek')).toHaveCount(0);
});

test('a swap card answers with a swipe: toward the end accepts, toward the start declines', async ({page, openApp, backend}, info) => {
  backend.raw.months[0].status = 'published';
  const request = (id: string) => ({id, month: '2026-11', source_publication_id: backend.raw.publications[0].id, requester_id: ids.b, other_id: ids.a,
    from_day: '2026-11-03', from_end_day: '2026-11-04', to_day: '2026-11-02', to_end_day: '2026-11-03', explanation: '', status: 'awaiting_engineer' as const,
    accepted_by: null, accepted_at: null, created_at: '2026-10-09T09:00:00Z', resolved_at: null, resolved_by: null, result_publication_id: null, override_reason: ''});
  backend.raw.swapRequests = [request('first'), {...request('second'), created_at: '2026-10-09T08:00:00Z'}];
  await openApp('a');
  const swipe = async (id: string, dx: number) => {
    const b = (await page.locator(`[data-swap-card="${id}"]`).boundingBox())!, x = b.x + b.width / 2, y = b.y + 20;
    if (info.project.name === 'mobile') await touchSwipe(page, x, y, dx);
    else {await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y, {steps: 10}); await page.mouse.up();}
  };
  await swipe('first', 300);
  await expect.poll(() => backend.raw.swapRequests!.find(r => r.id === 'first')!.status).toBe('awaiting_admin');
  await expect(page.locator('[data-swap-card="first"]')).toHaveCount(0);
  await swipe('second', -300);
  await expect.poll(() => backend.raw.swapRequests!.find(r => r.id === 'second')!.status).toBe('declined');
  await expect(page.locator('[data-swap-card]')).toHaveCount(0);
});

test('a bell item swipes away and stays dismissed on this device', async ({page, openApp}, info) => {
  await openApp();
  await page.locator('[data-bell]').click();
  const items = page.locator('.bell-list > li'), count = await items.count();
  expect(count).toBeGreaterThan(0);
  const b = (await items.first().boundingBox())!, x = b.x + b.width / 2, y = b.y + b.height / 2;
  if (info.project.name === 'mobile') await touchSwipe(page, x, y, -280);
  else {await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x - 280, y, {steps: 10}); await page.mouse.up();}
  await expect(items).toHaveCount(count - 1);
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('duty-activity-dismissed') ?? '[]'))).toHaveLength(1);
});

test('Settings slides out when it closes on a phone', async ({page, openApp}, info) => {
  test.skip(info.project.name !== 'mobile', 'Phone page.');
  await page.emulateMedia({reducedMotion: 'no-preference'});
  await openApp();
  await page.locator('[data-settings-button]').click();
  const sheet = page.getByRole('dialog', {name: 'Settings'});
  await expect(sheet).toBeVisible();
  await page.waitForTimeout(400);
  await sheet.locator('.sheet-back').click();
  const leaving = await page.locator('.sheet-page').evaluate(el => el.getAnimations().map(a => (a as CSSAnimation).animationName));
  expect(leaving).toContain('page-out');
  await expect(sheet).toHaveCount(0);
});

test('the PC sidebar folds with its icons staying put', async ({page, openApp}, info) => {
  test.skip(info.project.name !== 'desktop', 'PC sidebar.');
  await openApp();
  const icon = page.getByRole('tab', {name: 'Team', exact: true}).locator('svg');
  const before = (await icon.boundingBox())!;
  const main = (await page.locator('.main-wrap').boundingBox())!;
  await page.emulateMedia({reducedMotion: 'no-preference'});
  await page.getByRole('button', {name: 'Collapse sidebar'}).click();
  // Mid-animation the page has not moved yet, and the icon never moves.
  await page.waitForTimeout(100);
  expect((await page.locator('.main-wrap').boundingBox())!.x).toBe(main.x);
  expect((await icon.boundingBox())!.x).toBe(before.x);
  await expect.poll(async () => (await page.locator('.side').boundingBox())!.width).toBe(72);
  expect((await icon.boundingBox())!.x).toBe(before.x);
});
