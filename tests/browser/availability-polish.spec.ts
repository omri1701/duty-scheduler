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
      await expect(hint).toHaveText(lang === 'en' ? `${Number(from)} November` : `${Number(from)} בנובמבר`);
      expect(await positions()).toEqual(original);
      await touchEvent(page, 'touchmove', target.x, target.y);
      const title = from === to ? (lang === 'en' ? '5 November' : '5 בנובמבר') : (lang === 'en' ? '5–9 November' : '5–9 בנובמבר');
      await expect(hint).toHaveText(title);
      expect(await positions()).toEqual(original);
      await touchEvent(page, 'touchend', target.x, target.y);
      const sheet = page.getByRole('dialog', {name: title, exact: true});
      await expect(sheet).toBeVisible();
      await expect(sheet).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
      await expect(hint).toHaveText(instructions);
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
      expect(box.x).toBe(0); expect(box.width).toBe(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.evaluate(() => {
        delete (window.visualViewport as unknown as {height?: number}).height;
        window.visualViewport!.dispatchEvent(new Event('resize'));
      });
      // Outside taps retain unsaved edits and highlights.
      await page.locator('[data-slot=dialog-overlay]').click({position: {x: 10, y: 10}});
      await expect(description).toHaveValue('Long description '.repeat(17));
      await expect(page.locator('.date-selected')).toHaveCount(from === to ? 1 : 5);
      if (from === '09') await sheet.locator('.constraint-popover-title button').click();
      else await page.keyboard.press('Escape');
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

test('ranges containing different notes cannot overwrite them; single note editing remains available', async ({page, openApp, backend}, info) => {
  test.skip(info.project.name !== 'mobile', 'Phone sheet.');
  backend.raw.constraints.push(...['05', '07'].map((d, i) => ({member_id: ids.admin, day: `2026-11-${d}`, kind: 'no' as const, note: `Original note ${i}`})));
  const original = structuredClone(backend.raw.constraints);
  await openApp(); await page.getByRole('tab').nth(1).click();
  const target = await hold(page, '05', '09');
  await touchEvent(page, 'touchmove', target.x, target.y);
  await touchEvent(page, 'touchend', target.x, target.y);
  await expect(page.locator('.constraint-notes-help')).toContainText('Edit dates individually');
  await expect(page.getByRole('button', {name: 'Save', exact: true})).toBeDisabled();
  await page.keyboard.press('Escape');
  expect(backend.raw.constraints).toEqual(original);
  // The gesture intentionally suppresses synthetic clicks briefly after release.
  await page.clock.setFixedTime(new Date(Date.parse(NOW) + 1000));
  await day(page, '05').click();
  await expect(page.getByLabel('Description (optional)')).toHaveValue('Original note 0');
  await page.getByLabel('Description (optional)').fill('Updated single note');
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  await page.route('**/rest/v1/rpc/duty_set_constraints', async route => {await gate; await route.fallback();});
  const request = page.waitForRequest('**/rest/v1/rpc/duty_set_constraints');
  await page.getByRole('button', {name: 'Save', exact: true}).click(); await request;
  await expect(page.getByRole('button', {name: 'Save', exact: true})).toBeDisabled();
  await expect(page.locator('.constraint-popover-title button')).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toBeVisible();
  release();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(backend.calls.filter(c => c.name === 'duty_set_constraints')).toHaveLength(1);
  expect(backend.raw.constraints.find(c => c.member_id === ids.admin && c.day === '2026-11-05')!.note).toBe('Updated single note');
  expect(backend.raw.constraints.find(c => c.member_id === ids.admin && c.day === '2026-11-07')!.note).toBe('Original note 1');
});
