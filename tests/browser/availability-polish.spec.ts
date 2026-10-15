import {test, expect, ids, NOW, touchEvent} from './fixtures';
import type {Page} from '@playwright/test';

const day = (page: Page, date: string) => page.locator(`.availability-day[data-gesture-key="2026-11-${date}"]`);
async function hold(page: Page, from: string, to: string) {
  const a = (await day(page, from).boundingBox())!, b = (await day(page, to).boundingBox())!;
  await touchEvent(page, 'touchstart', a.x + a.width / 2, a.y + a.height / 2);
  await page.waitForTimeout(350);
  return {x: b.x + b.width / 2, y: b.y + b.height / 2};
}

for (const width of [320, 375, 390, 430]) for (const lang of ['en', 'he'] as const) {
  test(`availability stable selection and sheet at ${width}px ${lang}`, async ({page, openApp, backend}, info) => {
    test.skip(info.project.name !== 'mobile', 'Touch matrix runs once.');
    await page.setViewportSize({width, height: 844});
    await openApp();
    if (lang === 'he') await page.getByRole('button', {name: 'Switch to Hebrew'}).click();
    await page.getByRole('tab').nth(1).click();
    const header = page.locator('.availability-tools'), hint = header.locator('.gesture-hint');
    const instructions = await hint.innerText();
    const positions = () => page.locator('.availability-tools,.mobile-availability-weekdays,.availability-grid').evaluateAll(els => els.map(el => {
      const {x,y,width,height} = el.getBoundingClientRect(); return {x,y,width,height};
    }));
    const original = await positions();
    for (const [from, to] of [['05', '09'], ['09', '05'], ['05', '05']]) {
      const target = await hold(page, from, to);
      await expect(hint).toHaveText(lang === 'en' ? '1 day selected' : 'נבחר יום אחד');
      expect(await positions()).toEqual(original);
      await touchEvent(page, 'touchmove', target.x, target.y);
      const title = from === to ? (lang === 'en' ? '5 November' : '5 בנובמבר') : (lang === 'en' ? '5–9 November' : '5–9 בנובמבר');
      await expect(hint).toHaveText(from === to ? (lang === 'en' ? '1 day selected' : 'נבחר יום אחד') : (lang === 'en' ? '5 days selected' : 'נבחרו 5 ימים'));
      expect(await positions()).toEqual(original);
      await touchEvent(page, 'touchend', target.x, target.y);
      const sheet = page.getByRole('dialog', {name: title, exact: true});
      await expect(sheet).toBeVisible();
      await expect(sheet).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
      await expect(hint).toContainText(lang === 'en' ? 'selected' : 'נבחר');
      expect(await positions()).toEqual(original);
      await expect(page.locator('.date-selected')).toHaveCount(from === to ? 1 : 5);
      if (from !== to) await expect(sheet.locator('.constraint-range-help')).toHaveText(lang === 'en' ? 'Applies to all selected dates' : 'חל על כל התאריכים שנבחרו');
      const description = sheet.locator('textarea');
      await description.fill('Long description '.repeat(17));
      await description.focus();
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport!, 'height', {configurable: true, value: innerHeight - 300});
        window.visualViewport!.dispatchEvent(new Event('resize'));
      });
      await expect.poll(async () => {
        const b = (await sheet.boundingBox())!; return b.y + b.height;
      }).toBeLessThanOrEqual(544);
      const box = (await sheet.boundingBox())!;
      expect(box.x).toBe(12); expect(box.width).toBe(width - 24);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.evaluate(() => {
        delete (window.visualViewport as unknown as {height?: number}).height;
        window.visualViewport!.dispatchEvent(new Event('resize'));
      });
      // Every dismissal discards local edits without writing.
      if (from === '09') await sheet.getByRole('button', {name: 'Close', exact: true}).click();
      else if (from === to) await page.keyboard.press('Escape');
      else await page.locator('[data-slot=dialog-overlay]').click({position: {x: 5, y: 5}});
      await expect(sheet).toBeHidden();
      await expect(page.locator('.date-selected')).toHaveCount(0);
      expect(await positions()).toEqual(original);
    }
    const target = await hold(page, '09', '05');
    await touchEvent(page, 'touchmove', target.x, target.y);
    await touchEvent(page, 'touchcancel', target.x, target.y);
    await expect(hint).toHaveText(instructions);
    await expect(page.locator('.date-selected')).toHaveCount(0);
    expect(await positions()).toEqual(original);
    expect(backend.calls.filter(c => c.name === 'duty_set_constraints')).toEqual([]);
  });
}

test('bulk notes warn, allow confirmation cancellation, and replace deliberately; single edits prefill', async ({page, openApp, backend}, info) => {
  test.skip(info.project.name !== 'mobile', 'Touch range.');
  backend.raw.constraints.push(...['05', '07'].map((d, i) => ({member_id: ids.admin, day: `2026-11-${d}`, kind: 'no' as const, note: `Original note ${i}`})));
  const original = structuredClone(backend.raw.constraints);
  await openApp(); await page.getByRole('tab').nth(1).click();
  const target = await hold(page, '05', '09');
  await touchEvent(page, 'touchmove', target.x, target.y);
  await touchEvent(page, 'touchend', target.x, target.y);
  await expect(page.locator('.constraint-notes-help')).toContainText('existing descriptions will be cleared');
  await expect(page.getByRole('button', {name: 'Save', exact: true})).toBeEnabled();
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  const confirmation = page.getByRole('alertdialog');
  await expect(confirmation).toContainText('existing descriptions will be cleared');
  await confirmation.getByRole('button', {name: 'Cancel', exact: true}).click();
  await expect(confirmation).toBeHidden();
  await expect(page.getByRole('button', {name: 'Save', exact: true})).toBeFocused();
  expect(backend.raw.constraints).toEqual(original);
  expect(backend.calls.filter(c => c.name === 'duty_set_constraints')).toHaveLength(0);
  await page.getByRole('button', {name: 'Prefer duty', exact: true}).click();
  await page.getByLabel('Description (optional)').fill('New shared note');
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(confirmation).toContainText('replaced with the new description');
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  await page.route('**/rest/v1/rpc/duty_set_constraints', async route => {await gate; await route.fallback();});
  const request = page.waitForRequest('**/rest/v1/rpc/duty_set_constraints');
  await confirmation.getByRole('button', {name: 'Replace and save'}).click(); await request;
  await expect(confirmation.getByRole('button', {name: 'Replace and save'})).toBeDisabled();
  await expect(confirmation.getByRole('button', {name: 'Close', exact: true})).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  await expect(confirmation).toBeVisible();
  release();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(backend.calls.filter(c => c.name === 'duty_set_constraints')).toHaveLength(1);
  const saved = backend.raw.constraints.filter(c => c.member_id === ids.admin);
  expect(saved).toHaveLength(5);
  expect(saved.every(c => c.note === 'New shared note' && c.kind === 'prefer')).toBe(true);
  await page.clock.setFixedTime(new Date(Date.parse(NOW) + 1000));
  await day(page, '05').click();
  await expect(page.getByLabel('Description (optional)')).toHaveValue('New shared note');
  await page.getByLabel('Description (optional)').fill('Updated single note');
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(backend.raw.constraints.find(c => c.member_id === ids.admin && c.day === '2026-11-05')!.note).toBe('Updated single note');
  expect(backend.raw.constraints.find(c => c.member_id === ids.admin && c.day === '2026-11-07')!.note).toBe('New shared note');
  // Explicit note removal also requires consent, including on a single date.
  await day(page, '05').click();
  await page.getByRole('button', {name: 'Remove constraint', exact: true}).click();
  await expect(confirmation).toContainText('delete existing descriptions');
  await page.keyboard.press('Escape');
  expect(backend.raw.constraints.find(c => c.member_id === ids.admin && c.day === '2026-11-05')!.note).toBe('Updated single note');
  await page.getByRole('button', {name: 'Remove constraint', exact: true}).click();
  await confirmation.getByRole('button', {name: 'Remove constraints and notes', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(backend.raw.constraints.some(c => c.member_id === ids.admin && c.day === '2026-11-05')).toBe(false);
});
