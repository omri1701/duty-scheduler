import type {Page} from '@playwright/test';
import {test, expect, ids, switchLanguage, type Backend} from './fixtures';

// The month change (owner rounds 3-4, 2026-11-07): the neighbour is the real calendar, blurred while it
// slides in with the finger; the month name swipes on its own and the calendar then refreshes in
// place; landing and refreshes keep the grid on screen. Phones use real touch input (CDP), PC a mouse drag.
type Gesture = {move: (dx: number) => Promise<void>; end: () => Promise<void>};
async function press(page: Page, x: number, y: number, mobile: boolean): Promise<Gesture> {
  if (!mobile) {
    await page.mouse.move(x, y); await page.mouse.down();
    return {move: async dx => page.mouse.move(x + dx, y, {steps: 6}), end: async () => page.mouse.up()};
  }
  const cdp = await page.context().newCDPSession(page);
  let at = x;
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y}]});
  return {
    move: async dx => {for (let step = 1; step <= 6; step++) await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: at + (x + dx - at) * step / 6, y}]}); at = x + dx;},
    end: async () => {await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []}); await cdp.detach();},
  };
}
const heading = (page: Page) => page.locator('.month-bar .month-name');
/** A December with a combined weekend and a weekday on duty, so the neighbour has real chips. */
function december(backend: Backend) {
  backend.raw.months.push({month: '2026-12', deadline: '2026-11-24', status: 'draft', generated: true, current_publication_id: null, publication_sequence: 0});
  backend.raw.assignments.push(
    {id: 'dec-weekend', publication_id: null, day: '2026-12-04', end_day: '2026-12-06', primary_id: ids.a, secondary_id: null, manager_override: false, title: '', extra_points: 0, points: 1},
    {id: 'dec-day', publication_id: null, day: '2026-12-01', end_day: '2026-12-02', primary_id: ids.b, secondary_id: null, manager_override: false, title: '', extra_points: 0, points: 1});
}
const relative = async (page: Page, cell: string, pane: string) => {
  const c = (await page.locator(cell).boundingBox())!, p = (await page.locator(pane).boundingBox())!;
  return {x: c.x - p.x, y: c.y - p.y, width: c.width, height: c.height};
};

for (const lang of ['en', 'he'] as const) test(`dragging the calendar shows the real neighbour month, blurred, and lands it without a jump; the name waits for the release ${lang}`, async ({page, openApp, backend}, info) => {
  const mobile = info.project.name === 'mobile', he = lang === 'he';
  december(backend);
  await openApp();
  if (he) await switchLanguage(page, 'he');
  await page.getByRole('tab', {name: he ? 'לוח' : 'Schedule', exact: true}).click();
  const grid = (await page.locator('.month-pane .calendar-grid').first().boundingBox())!, head = (await page.locator('.calendar-weekdays:visible').first().boundingBox())!;
  // The next month comes from the reading end: drag left in English, right in Hebrew (also on PC).
  const toward = he ? 1 : -1, x = grid.x + grid.width / 2, y = mobile ? grid.y + 20 : head.y + head.height / 2;
  const name = (await heading(page).boundingBox())!;
  const g = await press(page, x, y, mobile);
  await g.move(toward * grid.width * .3);
  const peek = page.locator('.month-peek');
  await expect(peek).toHaveCount(1);
  // The same calendar: the combined weekend spans Friday–Saturday with its member's chip.
  await expect(peek.locator('button[data-date="2026-12-04"]')).toHaveClass(/combined-weekend/);
  await expect(peek.locator('button[data-date="2026-12-04"] .assignment-chip')).toContainText(backend.raw.members.find(m => m.id === ids.a)!.name.split(' ')[0]);
  await expect(peek.locator('.calendar-weekdays')).toBeVisible();
  expect(Number(await peek.evaluate(e => getComputedStyle(e).opacity))).toBeGreaterThan(.5);
  expect(await peek.evaluate(e => getComputedStyle(e).filter)).toContain('blur');
  // The swipes are separate (owner round 4): the name stays put while the calendar moves.
  await expect(page.locator('.month-name-peek')).toHaveCount(0);
  await expect(heading(page)).toHaveText(he ? 'נובמבר 2026' : 'November 2026');
  expect(Math.abs((await heading(page).boundingBox())!.x - name.x)).toBeLessThanOrEqual(.5);
  // Nothing moves inside the neighbour: its cells sit where they will sit once it lands.
  const before = await relative(page, '.month-peek button[data-date="2026-12-04"]', '.month-peek');
  await g.move(toward * grid.width * .6);
  await g.end();
  await expect(heading(page)).toHaveText(he ? 'דצמבר 2026' : 'December 2026');
  // The new name arrives blurred to sharp, not rolled.
  await expect(heading(page)).toHaveAttribute('data-arrive', '');
  await expect(heading(page)).not.toHaveAttribute('data-dir');
  await expect(peek).toHaveCount(0);
  const after = await relative(page, '.month-pane button[data-date="2026-12-04"]', '.month-pane');
  for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(after[k] - before[k]), k).toBeLessThanOrEqual(.5);
});

for (const lang of ['en', 'he'] as const) test(`dragging the month name moves only the name: the neighbour's name slides in and the calendar refreshes in place ${lang}`, async ({page, openApp}, info) => {
  const mobile = info.project.name === 'mobile', he = lang === 'he';
  await page.emulateMedia({reducedMotion: 'no-preference'});
  await openApp();
  if (he) await switchLanguage(page, 'he');
  await page.getByRole('tab', {name: he ? 'לוח' : 'Schedule', exact: true}).click();
  // Counts every neighbour calendar that ever appears: a name swipe never slides the calendar.
  await page.evaluate(() => {
    const w = window as Window & {peeks?: number}; w.peeks = 0;
    new MutationObserver(list => {for (const m of list) for (const n of m.addedNodes) if (n instanceof HTMLElement && n.matches('.month-peek')) w.peeks!++;}).observe(document.querySelector('.month-stage')!, {childList: true});
  });
  const name = (await heading(page).boundingBox())!, toward = he ? 1 : -1;
  // A short drag: the next month's name follows the finger, blurred; the calendar stays still.
  let g = await press(page, name.x + name.width / 2, name.y + name.height / 2, mobile);
  await g.move(toward * 30);
  const incoming = page.locator('.month-name-peek');
  await expect(incoming).toHaveText(he ? 'דצמבר 2026' : 'December 2026');
  expect(await incoming.evaluate(e => getComputedStyle(e).filter)).toContain('blur');
  expect(await page.locator('.month-pane').first().evaluate(e => e.style.transform)).toBe('');
  await expect(page.locator('.month-peek')).toHaveCount(0);
  // It snaps back.
  await g.end();
  await expect(incoming).toHaveCount(0);
  await expect(heading(page)).toHaveText(he ? 'נובמבר 2026' : 'November 2026');
  // A long one, starting on the text, changes month; the calendar refreshes without a slide.
  g = await press(page, name.x + name.width / 2, name.y + name.height / 2, mobile);
  await g.move(toward * 120);
  await g.end();
  await expect(heading(page)).toHaveText(he ? 'דצמבר 2026' : 'December 2026');
  await expect(heading(page)).not.toHaveAttribute('data-dir');
  await expect(page.locator('.calendar-grid [data-date]').first()).toHaveAttribute('data-date', '2026-11-29');
  expect(await page.evaluate(() => (window as Window & {peeks?: number}).peeks)).toBe(0);
  // Chevrons still turn the page (and the calendar slides for them).
  await page.getByRole('button', {name: he ? 'חודש קודם' : 'Previous month', exact: true}).click();
  await expect(heading(page)).toHaveText(he ? 'נובמבר 2026' : 'November 2026');
});

test('a six-week month peeks in whole and the calendar grows smoothly, with no jump when it lands', async ({page, openApp}, info) => {
  const mobile = info.project.name === 'mobile';
  await page.emulateMedia({reducedMotion: 'no-preference'});
  await openApp();
  await page.getByRole('tab', {name: 'Schedule', exact: true}).click();
  await page.getByRole('button', {name: 'Next month', exact: true}).click();
  await expect(heading(page)).toHaveText('December 2026');
  await expect(page.locator('.month-peek')).toHaveCount(0);
  const stage = page.locator('.month-stage');
  await expect.poll(async () => page.evaluate(() => document.querySelector('.month-stage')!.getAnimations().length)).toBe(0);
  const short = (await stage.boundingBox())!.height;
  // January 2027 starts on a Friday: six week rows against December's five.
  const grid = (await page.locator('.month-pane .calendar-grid').first().boundingBox())!, head = (await page.locator('.calendar-weekdays:visible').first().boundingBox())!;
  const g = await press(page, grid.x + grid.width / 2, mobile ? grid.y + 20 : head.y + head.height / 2, mobile);
  await g.move(-grid.width * .3);
  const last = page.locator('.month-peek button[data-date="2027-01-31"]');
  await expect(last).toHaveCount(1);
  // The whole neighbour shows: the stage eases to its height, so the sixth row is not clipped.
  await expect.poll(async () => (await stage.boundingBox())!.height).toBeGreaterThan(short + 20);
  await expect.poll(async () => {const c = (await last.boundingBox())!, s = (await stage.boundingBox())!; return c.y + c.height - (s.y + s.height);}).toBeLessThanOrEqual(0);
  const tall = (await stage.boundingBox())!.height;
  await g.move(-grid.width * .6);
  await g.end();
  await expect(heading(page)).toHaveText('January 2027');
  await expect(page.locator('.month-peek')).toHaveCount(0);
  // Landing keeps the height it grew to: nothing below jumps.
  expect(Math.abs((await stage.boundingBox())!.height - tall)).toBeLessThanOrEqual(1);
  // Swiping the name back to December eases the calendar down again.
  const name = (await heading(page).boundingBox())!;
  const back = await press(page, name.x + name.width / 2, name.y + name.height / 2, mobile);
  await back.move(120);
  await back.end();
  await expect(heading(page)).toHaveText('December 2026');
  await expect.poll(async () => Math.round((await stage.boundingBox())!.height)).toBe(Math.round(short));
});

test('a background refresh keeps the grid on screen and updates only the changed chip', async ({page, openApp, backend}) => {
  await openApp();
  await page.getByRole('tab', {name: 'Schedule', exact: true}).click();
  const chip = page.locator('.month-pane button[data-date="2026-11-04"] .assignment-chip');
  await expect(chip).toBeVisible();
  await page.locator('.month-pane .calendar-grid').evaluate(e => {(e as HTMLElement & {mark?: number}).mark = 1; (e.querySelector('[data-date="2026-11-10"]') as HTMLElement & {mark?: number}).mark = 1;});
  for (const r of backend.raw.assignments.filter(r => r.day === '2026-11-04')) r.primary_id = ids.e;
  backend.raw.revision!++;
  await page.locator('.brand-button:visible').first().click();
  await expect(chip).toContainText(backend.raw.members.find(m => m.id === ids.e)!.name.split(' ')[0]);
  // Same grid and same untouched cells: no remount, no blank-then-fill.
  expect(await page.locator('.month-pane .calendar-grid').evaluate(e => (e as HTMLElement & {mark?: number}).mark)).toBe(1);
  expect(await page.locator('.month-pane [data-date="2026-11-10"]').evaluate(e => (e as HTMLElement & {mark?: number}).mark)).toBe(1);
});

test('a phone with a notch: the header, Settings and sheets start below the top inset; the tab bar clears the home indicator', async ({page, openApp}, info) => {
  test.skip(info.project.name !== 'mobile', 'Phone safe areas.');
  await openApp();
  await page.evaluate(() => {document.documentElement.dataset.safeArea = 'test';});
  const top = 59, bottom = 34, height = page.viewportSize()!.height;
  expect((await page.locator('.hdr').first().locator('button').first().boundingBox())!.y).toBeGreaterThanOrEqual(top);
  const tabs = (await page.locator('.tabbar [role=tab]').first().boundingBox())!;
  expect(tabs.y + tabs.height).toBeLessThanOrEqual(height - bottom);
  await page.locator('[data-settings-button]').click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  for (const part of [sheet.locator('.sheet-title'), sheet.locator('.sheet-back')]) expect((await part.boundingBox())!.y).toBeGreaterThanOrEqual(top);
  // The strip under the status bar is the page colour, not a gap.
  expect(await sheet.evaluate(e => getComputedStyle(e).backgroundColor)).toBe(await page.evaluate(() => getComputedStyle(document.body).backgroundColor));
});
