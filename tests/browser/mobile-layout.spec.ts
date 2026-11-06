import {test, expect, ids, duty, monthAction, touchEvent, switchLanguage} from './fixtures';
import type {Page} from '@playwright/test';

async function fits(page: Page) {
  const size = await page.evaluate(() => ({width: innerWidth, document: document.documentElement.scrollWidth,
    overflow: [...document.querySelectorAll<HTMLElement>('.workspace-controls,.app-main,.main-wrap,.calendar-grid,.availability-grid,.team-list,.sheet')].map(el => ({name: el.className, width: el.getBoundingClientRect().width, min: getComputedStyle(el).minWidth}))}));
  expect(size.document, JSON.stringify(size)).toBeLessThanOrEqual(size.width);
}
// Tabs (decision 2026-11-06): Home · Schedule · Availability · Team.
const tab = (page: Page, index: number) => page.getByRole('tab').nth(index);

for (const width of [320, 375, 390, 430, 768, 1440]) {
  test(`layout at ${width}px: admin and engineer, English and Hebrew`, async ({page, openApp, backend}, info) => {
    test.skip(info.project.name !== 'desktop', 'The matrix runs once; existing mobile cases cover touch.');
    await page.setViewportSize({width, height: 900});
    backend.raw.members.find(m => m.id === ids.a)!.name = 'Alexandria Verylongfamilyname Atlas';
    backend.raw.constraints[0].note = 'Long appointment description '.repeat(10);
    const original = structuredClone(backend.raw);
    for (const identity of ['admin', 'a'] as const) {
      await openApp(identity);
      for (const language of ['en', 'he'] as const) {
        if (language === 'he') await switchLanguage(page, 'he');
        await expect(page.locator('.app-shell')).toHaveAttribute('dir', language === 'he' ? 'rtl' : 'ltr');
        await fits(page);
        await tab(page, 1).click();
        await fits(page);
        if (width === 390 && language === 'en') await page.screenshot({path: info.outputPath(`${identity}-schedule.png`), fullPage: true});
        await expect(duty(page, '2026-11-02')).toBeVisible();
        await expect(duty(page, '2026-11-06')).toHaveCSS('grid-column-start', 'span 2');
        await expect(duty(page, '2026-11-12').locator('.tiny-badge')).toBeVisible();
        if (identity === 'admin' && language === 'en') {
          // A tap opens the duty sheet on PC and the day's details on phones; both stay inside the screen.
          await duty(page, '2026-11-02').click();
          const dialog = page.getByRole('dialog'), details = page.locator('[data-day-details]');
          await expect(dialog.or(details).first()).toBeVisible();
          if (!(await dialog.isVisible())) await details.locator('.day-duty').click();
          await expect(dialog).toBeVisible();
          await fits(page);
          const box = (await dialog.boundingBox())!;
          expect(box.x, JSON.stringify(await dialog.evaluate(el=>({translate:getComputedStyle(el).translate, transform:getComputedStyle(el).transform, left:getComputedStyle(el).left})))).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
          await page.keyboard.press('Escape');
          await expect(dialog).toBeHidden();
        }
        await tab(page, 2).click();
        await fits(page);
        // Admins choose whose availability to edit; engineers see only their own.
        await expect(page.locator('.availability-screen .picker')).toHaveCount(identity === 'admin' ? 1 : 0);
        expect(await page.locator('.availability-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(7);
        if (width === 390) await page.screenshot({path: info.outputPath(`${identity}-availability-${language}.png`), fullPage: true});
        if (identity === 'a') {
          const day = page.locator('.availability-day[data-gesture-key="2026-11-04"]');
          await day.click();
          const editor = page.getByLabel(language === 'en' ? 'Description (optional)' : 'תיאור (לא חובה)');
          await expect(editor).toHaveValue(original.constraints[0].note);
          await editor.focus();
          if (width <= 600) {
            await expect(page.locator('.availability-dialog')).toBeVisible();
            // 16px keeps iOS from zooming into the field.
            await expect(editor).toHaveCSS('font-size', '16px');
          }
          await fits(page);
          await page.keyboard.press('Escape');
          await expect(day).toHaveAttribute('aria-pressed', 'false');
          await expect(day).toBeFocused();
        }
        await tab(page, 3).click();
        await fits(page);
        await expect(page.locator('.team-list').getByText('Alexandria Verylongfamilyname Atlas', {exact: true})).toBeVisible();
        await tab(page, 0).click();
      }
    }
    expect(backend.raw).toEqual(original);
    expect(backend.calls.filter(c => !['duty_load','duty_join','duty_generation_context','duty_balance','duty_set_language','duty_notification_settings','duty_calendar_status'].includes(c.name))).toEqual([]);
    for(const call of backend.calls.filter(c=>c.name==='duty_generation_context'))expect(call.user).toBe(ids.admin);
  });
}

test('phone actions, bottom tabs, sheet focus and keyboard clearance', async ({page, openApp}, info) => {
  test.skip(info.project.name !== 'mobile', 'Phone-specific controls.');
  await openApp();
  await page.getByRole('tab', {name: 'Schedule', exact: true}).click();
  // One state-driven primary action (decision 2026-11-06) and the ⋯ menu.
  await expect(page.locator('.month-primary')).toHaveText(/^(Review plan|Publish)$/);
  await expect(page.getByRole('button', {name: 'Month actions', exact: true})).toBeVisible();
  await monthAction(page, 'Constraints deadline');
  await expect(page.getByRole('dialog')).toBeVisible();
  await fits(page);
  await page.keyboard.press('Escape');
  await monthAction(page, 'Versions');
  await expect(page.getByRole('dialog')).toBeVisible();
  await fits(page);
  await page.keyboard.press('Escape');
  const navigation = await page.locator('.tabbar').boundingBox();
  expect(navigation!.y + navigation!.height).toBe(844);
  const capsule = (await page.locator('.mobile-navigation').boundingBox())!;
  expect(capsule.x).toBeGreaterThan(0);
  expect(capsule.y + capsule.height).toBeLessThan(844);
  await page.getByRole('tab', {name: 'Availability', exact: true}).click();
  const day = page.locator('.availability-day[data-gesture-key="2026-11-05"]');
  await day.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(day).toHaveAttribute('aria-pressed', 'true');
  // A bottom sheet: edge to edge, resting on the bottom of the screen.
  const sheet = page.locator('.availability-dialog');
  const sheetBox = (await sheet.boundingBox())!;
  expect(sheetBox.x).toBe(0);
  expect(sheetBox.width).toBe(390);
  expect(Math.abs(sheetBox.y + sheetBox.height - 844)).toBeLessThan(1);
  await page.screenshot({path: info.outputPath('availability-sheet.png')});
  await page.keyboard.press('Tab');
  expect(await page.getByRole('dialog').evaluate(el => el.contains(document.activeElement))).toBe(true);
  // Validate our viewport response, not Safari's actual keyboard behavior.
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', {configurable: true, value: innerHeight - 300});
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('.tabbar')).toBeHidden();
  await expect.poll(async () => {const b = (await sheet.boundingBox())!; return b.y + b.height;}).toBeLessThanOrEqual(544);
  await page.evaluate(() => {
    delete (window.visualViewport as unknown as {height?: number}).height;
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await page.keyboard.press('Escape');
  await expect(day).toBeFocused();
  await expect(day).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.tabbar')).toBeVisible();
});

test('phone availability hold and drag saves and clears a date range', async ({page, openApp, backend}, info) => {
  test.skip(info.project.name !== 'mobile', 'Touch range editing.');
  await openApp();
  await page.getByRole('tab', {name: 'Availability', exact: true}).click();
  const first = page.locator('.availability-day[data-gesture-key="2026-11-05"]');
  const last = page.locator('.availability-day[data-gesture-key="2026-11-09"]');
  async function selectRange() {
    const a = (await first.boundingBox())!, b = (await last.boundingBox())!;
    const x = a.x + a.width / 2, y = a.y + a.height / 2;
    await touchEvent(page, 'touchstart', x, y);
    await page.waitForTimeout(350);
    await touchEvent(page, 'touchmove', b.x + b.width / 2, b.y + b.height / 2);
    await touchEvent(page, 'touchend', b.x + b.width / 2, b.y + b.height / 2);
    await expect(page.getByRole('dialog', {name: '5–9 November', exact: true})).toBeVisible();
  }
  await selectRange();
  await page.getByRole('button', {name: 'Prefer duty', exact: true}).click();
  await page.getByLabel('Description (optional)').fill('Synthetic range note');
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(backend.raw.constraints.filter(c => c.member_id === ids.admin)).toHaveLength(5);
  await selectRange();
  await page.getByRole('button', {name: 'Remove constraint', exact: true}).click();
  await page.getByRole('alertdialog').getByRole('button', {name: 'Remove constraints and notes', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(backend.raw.constraints.filter(c => c.member_id === ids.admin)).toEqual([]);
  expect(backend.calls.filter(c => c.name === 'duty_set_constraints').map(c => c.params.p_days)).toEqual([
    ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'],
    ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'],
  ]);
});
