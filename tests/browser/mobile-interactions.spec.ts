import {test, expect, duty, touchEvent, ids, NOW} from './fixtures';

test('navigation follows horizontal touch, commits on release and respects RTL and keyboard', async ({page, openApp, backend}, info) => {
  test.skip(info.project.name !== 'mobile', 'Phone navigation.');
  await openApp();
  const client = await page.context().newCDPSession(page);
  for (const rtl of [false, true]) {
    if (rtl) await page.getByRole('button', {name: 'Switch to Hebrew'}).click();
    const tabs = page.getByRole('tab');
    await tabs.nth(0).click();
    const a = (await tabs.nth(0).boundingBox())!, b = (await tabs.nth(2).boundingBox())!;
    const x = a.x + a.width / 2, y = a.y + a.height / 2, end = b.x + b.width / 2;
    await client.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y}]});
    for (let step = 1; step <= 8; step++) await client.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: x + (end - x) * step / 8, y}]});
    await expect(page.locator('.mobile-navigation')).toHaveAttribute('data-sliding', 'true');
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
    await client.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
    await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
    await tabs.nth(0).focus();
    await page.keyboard.press(rtl ? 'ArrowLeft' : 'ArrowRight');
    await expect(tabs.nth(1)).toBeFocused();
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  }
  expect(backend.calls.filter(c => c.name === 'duty_save_schedule')).toEqual([]);
});

test('mobile cells have only note dots and outside taps retain sheet edits', async ({page, openApp}, info) => {
  test.skip(info.project.name !== 'mobile', 'Phone sheet.');
  await openApp('a');
  await page.getByRole('tab').nth(1).click();
  const noted = page.locator('.availability-day[data-gesture-key="2026-11-04"]');
  await expect(page.locator('.availability-day .availability-marker')).toHaveCount(0);
  await expect(noted.locator('.mobile-note-dot')).toHaveCount(1);
  await expect(page.locator('.availability-day[data-gesture-key="2026-11-05"] .mobile-note-dot')).toHaveCount(0);
  const cell = (await noted.boundingBox())!, number = (await noted.locator('strong').boundingBox())!;
  expect(Math.abs(number.x + number.width / 2 - cell.x - cell.width / 2)).toBeLessThan(1);
  expect(Math.abs(number.y + number.height / 2 - cell.y - cell.height / 2)).toBeLessThan(1);
  await noted.click();
  await page.getByLabel('Description (optional)').fill('Unsaved edit');
  await page.mouse.click(5, 5);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Description (optional)')).toHaveValue('Unsaved edit');
  await page.keyboard.press('Escape');
  await expect(noted).toBeFocused();
});

test('duty preview follows touch and cancellation never writes; team body scrolling does not reorder', async ({page, openApp, backend}, info) => {
  test.skip(info.project.name !== 'mobile', 'Touch presentation.');
  await page.emulateMedia({reducedMotion: 'no-preference'});
  await openApp();
  await page.getByRole('tab').nth(1).click();
  await page.getByRole('tab').nth(0).click();
  const from = duty(page, '2026-11-02'), to = duty(page, '2026-11-03');
  const a = (await from.boundingBox())!, b = (await to.boundingBox())!;
  const x = a.x + a.width / 2, y = a.y + a.height / 2;
  await touchEvent(page, 'touchstart', x, y);
  await page.waitForTimeout(400);
  await expect(page.locator('.mobile-drag-preview')).toBeVisible();
  await touchEvent(page, 'touchmove', b.x + b.width / 2, y);
  const ghost = (await page.locator('.mobile-drag-preview').boundingBox())!;
  expect(Math.abs(ghost.x + ghost.width / 2 - b.x - b.width / 2)).toBeLessThan(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('.mobile-drag-preview')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('tab').nth(2).click();
  const row = page.locator(`.team-row[data-gesture-key="${ids.admin}"] .team-name`);
  const r = (await row.boundingBox())!;
  await touchEvent(page, 'touchstart', r.x + 10, r.y + 10);
  await page.waitForTimeout(400);
  await touchEvent(page, 'touchmove', r.x + 10, r.y + 50);
  await touchEvent(page, 'touchend', r.x + 10, r.y + 50);
  await expect(page.locator('.mobile-drag-preview')).toHaveCount(0);
  expect(backend.calls.filter(c => c.name === 'duty_save_schedule')).toEqual([]);
});

test('combined weekend dates align with daily columns across month and year', async ({page, openApp}) => {
  await openApp();
  for (let i = 0; i < 13; i++) await page.getByRole('button', {name: 'Next month', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'December 2027'})).toBeVisible();
  const weekend = duty(page, '2027-12-31');
  await expect(weekend.locator('.day-number')).toHaveText(['31', '1']);
  await expect(weekend.locator('.assignment-chip')).toHaveCount(1);
  await expect(duty(page, '2028-01-01')).toHaveCount(0);
  const dates = await weekend.locator('.day-number').evaluateAll(nodes => nodes.map(node => {const range = document.createRange(); range.selectNodeContents(node); const r = range.getBoundingClientRect(); return {x: r.x + (innerWidth <= 600 ? r.width / 2 : 0)};}));
  const daily = await duty(page, '2027-12-30').locator('.day-number').evaluate(node => {const range=document.createRange();range.selectNodeContents(node);const r=range.getBoundingClientRect();return r.x+(innerWidth<=600?r.width/2:0);});
  const column = (await duty(page, '2027-12-30').boundingBox())!.width;
  expect(Math.abs(dates[0].x - daily - column)).toBeLessThan(1);
  expect(Math.abs(dates[1].x - daily - 2 * column)).toBeLessThan(1);
  await page.getByRole('button', {name: 'Next month', exact: true}).click();
  await expect(duty(page, '2027-12-31').locator('.day-number')).toHaveText(['31', '1']);
  await expect(duty(page, '2028-01-01')).toHaveCount(0);
});

test('mobile rejects unassigned drag targets and cannot cancel an assignment save in flight', async ({page, openApp, backend}, info) => {
  test.skip(info.project.name !== 'mobile', 'Phone editing guards.');
  backend.raw.assignments = backend.raw.assignments.filter(d => d.day !== '2026-11-03');
  await openApp();
  const first = duty(page, '2026-11-02'), empty = duty(page, '2026-11-03');
  const a = (await first.boundingBox())!, b = (await empty.boundingBox())!;
  await touchEvent(page, 'touchstart', a.x + a.width / 2, a.y + a.height / 2);
  await page.waitForTimeout(400);
  await touchEvent(page, 'touchmove', b.x + b.width / 2, b.y + b.height / 2);
  await expect(empty).not.toHaveClass(/drag-target/);
  await touchEvent(page, 'touchend', b.x + b.width / 2, b.y + b.height / 2);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // The shared gesture suppresses its trailing compatibility click for 700ms.
  await page.clock.setFixedTime(new Date(Date.parse(NOW) + 1000));
  // Release delayed persistence explicitly, without relying on a timing race.
  let release!: () => void;
  const pending = new Promise<void>(resolve => {release = resolve;});
  await page.route('**/rest/v1/rpc/duty_save_schedule', async route => {await pending; await route.fallback();});
  await first.click();
  await page.getByRole('button', {name: 'Save assignment', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Cancel', exact: true})).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();
  release();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(backend.calls.filter(c => c.name === 'duty_save_schedule')).toHaveLength(1);
});
