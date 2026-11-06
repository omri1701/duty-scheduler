import {test, expect, ids, switchLanguage} from './fixtures';
import type {Page} from '@playwright/test';
import {PROJECTS} from '../../lib/supabase/environment';
import {existsSync} from 'node:fs';
import {mockPush, VAPID_PUBLIC_KEY} from './push-mock';

// The redesign gallery (decision 2026-11-06): every screen in light and dark, English and Hebrew.
test.beforeEach(({backend}) => {backend.url = PROJECTS.prod; backend.runtimeOrigin = 'https://duty-scheduler-prod.vercel.app';});

async function snapshot(page: Page, name: string) {
  test.info().annotations.push({type: 'visual-review', description: JSON.stringify({name: name + '.png', viewport: page.viewportSize(), language: await page.locator('html').getAttribute('lang')})});
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  if (!existsSync(test.info().snapshotPath(name + '.png'))) {
    const path = test.info().outputPath(name + '-actual.png');
    await page.screenshot({path, fullPage: true, animations: 'disabled', caret: 'hide'});
    await test.info().attach(name + '-actual.png', {path, contentType: 'image/png'});
  }
  await expect.soft(page).toHaveScreenshot(name + '.png', {fullPage: true});
}
/** Light, then dark (the theme follows the device by default). */
async function both(page: Page, name: string) {
  await page.emulateMedia({colorScheme: 'light'});
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await snapshot(page, name);
  await page.emulateMedia({colorScheme: 'dark'});
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await snapshot(page, `${name}-dark`);
  await page.emulateMedia({colorScheme: 'light'});
}
const tab = (page: Page, name: string) => page.getByRole('tab', {name, exact: true});

for (const lang of ['en', 'he'] as const) {
  const t = (en: string, he: string) => lang === 'en' ? en : he;

  test(`home, schedule and duty sheet ${lang}`, async ({page, openApp, backend}, info) => {
    const mobile = info.project.name === 'mobile';
    backend.raw.months[0].status = 'published';
    // Today is 9 Oct 2026 (fixtures): the admin's next duty is in November.
    await openApp('admin');
    if (lang === 'he') await switchLanguage(page, 'he');
    await both(page, `home-admin-${lang}`);
    await tab(page, t('Schedule', 'לוח')).click();
    await expect(page.locator('.calendar-grid')).toBeVisible();
    await both(page, `schedule-${lang}`);
    const duty = page.locator('button[data-date="2026-11-03"]').filter({has: page.locator('.date-line')});
    await duty.click();
    if (mobile) {
      await expect(page.locator('[data-day-details]')).toBeVisible();
      await both(page, `schedule-day-${lang}`);
      await page.locator('[data-day-details] .day-duty').click();
    }
    await expect(page.getByRole('dialog')).toBeVisible();
    await both(page, `duty-sheet-${lang}`);
  });

  test(`engineer home ${lang}`, async ({page, openApp}) => {
    await openApp('a');
    if (lang === 'he') await switchLanguage(page, 'he');
    await expect(page.locator('.hero').first()).toBeVisible();
    await both(page, `home-engineer-${lang}`);
  });

  test(`availability and team ${lang}`, async ({page, openApp, backend}) => {
    backend.raw.members.find(m => m.id === ids.e)!.no_weekends = true;
    await openApp('admin');
    if (lang === 'he') await switchLanguage(page, 'he');
    await tab(page, t('Availability', 'אילוצים')).click();
    await expect(page.locator('.availability-grid')).toBeVisible();
    await both(page, `availability-${lang}`);
    await tab(page, t('Team', 'צוות')).click();
    await expect(page.locator('.team-list')).toBeVisible();
    await both(page, `team-${lang}`);
  });

  test(`plan the month ${lang}`, async ({page, openApp, backend}) => {
    backend.raw.assignments = []; backend.raw.publications = [];
    backend.raw.months[0] = {...backend.raw.months[0], current_publication_id: null, status: 'draft', generated: false};
    backend.raw.assignments.push({id: 'locked', publication_id: null, day: '2026-11-10', end_day: '2026-11-11', primary_id: ids.admin, secondary_id: null, title: '', extra_points: 0, points: 1, locked: true, manager_override: false});
    await openApp('admin');
    if (lang === 'he') await switchLanguage(page, 'he');
    await tab(page, t('Schedule', 'לוח')).click();
    await page.getByRole('button', {name: t('Plan the month', 'תכנון החודש'), exact: true}).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', {name: t('Confirm & generate', 'אישור ושיבוץ'), exact: true})).toBeEnabled({timeout: 30_000});
    await page.mouse.move(0, 0);
    await both(page, `plan-${lang}`);
  });

  test(`settings ${lang}`, async ({page, openApp, backend}) => {
    await mockPush(page);
    backend.vapidPublicKey = VAPID_PUBLIC_KEY;
    await openApp('admin');
    if (lang === 'he') await switchLanguage(page, 'he');
    await page.locator('[data-settings-button]').click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByRole('button', {name: t('Enable', 'הפעלה'), exact: true})).toBeEnabled();
    await both(page, `settings-${lang}`);
  });
}

// Phase 2 screens: Team member sheet and swipe, swaps on Home, editors, menus, welcome, access, offline.
for (const lang of ['en', 'he'] as const) {
  const t = (en: string, he: string) => lang === 'en' ? en : he;
  const request = (backend: {raw: {publications: {id: string}[]}}, status: 'awaiting_engineer' | 'awaiting_admin') => ({
    id: `request-${status}`, month: '2026-11', source_publication_id: backend.raw.publications[0].id, requester_id: ids.b, other_id: ids.a,
    from_day: '2026-11-03', from_end_day: '2026-11-04', to_day: '2026-11-02', to_end_day: '2026-11-03', explanation: 'Family event', status,
    accepted_by: status === 'awaiting_admin' ? ids.a : null, accepted_at: status === 'awaiting_admin' ? '2026-10-09T10:00:00Z' : null, created_at: '2026-10-09T09:00:00Z',
    resolved_at: null, resolved_by: null, result_publication_id: null, override_reason: '',
  });

  test(`team member sheet, swipe and inactive group ${lang}`, async ({page, openApp, backend}, info) => {
    backend.raw.members.find(m => m.id === ids.e)!.no_weekends = true;
    backend.raw.members.find(m => m.id === ids.d)!.active = false;
    await openApp('admin');
    if (lang === 'he') await switchLanguage(page, 'he');
    await tab(page, t('Team', 'צוות')).click();
    await expect(page.locator('.team-list')).toBeVisible();
    await page.locator('.team-group').click();
    await both(page, `team-${lang}`);
    if (info.project.name === 'mobile') {
      const row = page.locator(`[data-member="${ids.b}"] .swipe-content`);
      const box = (await row.boundingBox())!;
      const x = box.x + box.width * .6, y = box.y + box.height / 2;
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x - 30, y, {steps: 3}); await page.mouse.move(x - 80, y, {steps: 5}); await page.mouse.up();
      await expect(page.locator(`[data-member="${ids.b}"]`)).toHaveClass(/swipe-open/);
      await both(page, `team-swipe-${lang}`);
      await page.locator(`[data-member="${ids.b}"] .swipe-action`).click();
      await expect(page.locator(`[data-member="${ids.b}"]`)).toHaveClass(/inactive/);
    }
    await page.locator(`[data-member="${ids.c}"] .team-row-inner`).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await both(page, `member-sheet-${lang}`);
  });

  test(`swaps on home ${lang}`, async ({page, openApp, backend}) => {
    backend.raw.months[0].status = 'published';
    backend.raw.swapRequests = [request(backend, 'awaiting_engineer')];
    await openApp('a');
    if (lang === 'he') await switchLanguage(page, 'he');
    await expect(page.locator('[data-swap-card]')).toBeVisible();
    await both(page, `home-swaps-${lang}`);
    backend.raw.swapRequests = [request(backend, 'awaiting_admin')];
    await openApp('admin');
    if (lang === 'he') await switchLanguage(page, 'he');
    await page.locator('[data-swap-card]').getByRole('button', {name: t('Approve', 'אישור'), exact: true}).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await both(page, `swap-approve-${lang}`);
  });

  test(`editors and menus ${lang}`, async ({page, openApp}, info) => {
    const mobile = info.project.name === 'mobile';
    await openApp('admin');
    if (lang === 'he') await switchLanguage(page, 'he');
    await tab(page, t('Schedule', 'לוח')).click();
    const open = async (day: string) => {
      await page.locator(`button[data-date="${day}"]`).filter({has: page.locator('.date-line')}).click();
      if (mobile) await page.locator('[data-day-details] .day-duty').click();
      await expect(page.getByRole('dialog')).toBeVisible();
    };
    await open('2026-11-04');
    await page.getByRole('dialog').getByRole('button', {name: t('Edit', 'עריכה'), exact: true}).click();
    await expect(page.getByRole('dialog').getByRole('button', {name: t('Save assignment', 'שמירת השיבוץ'), exact: true})).toBeVisible();
    await both(page, `duty-editor-${lang}`);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    const menu = page.getByRole('button', {name: t('Month actions', 'פעולות לחודש'), exact: true});
    await menu.click();
    await both(page, `month-menu-${lang}`);
    await page.getByRole('menuitem', {name: t('Versions', 'גרסאות'), exact: true}).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await both(page, `versions-${lang}`);
    await page.keyboard.press('Escape');
    await menu.click();
    await page.getByRole('menuitem', {name: t('Special block', 'מקטע מיוחד'), exact: true}).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await both(page, `special-block-${lang}`);
    await page.keyboard.press('Escape');
    await menu.click();
    await page.getByRole('menuitem', {name: t('Clear board', 'ניקוי הלוח'), exact: true}).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await both(page, `clear-board-${lang}`);
    await page.keyboard.press('Escape');
    await tab(page, t('Availability', 'אילוצים')).click();
    await page.locator('.availability-day[data-gesture-key="2026-11-05"]').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await both(page, `availability-editor-${lang}`);
  });

  test(`published duty edit and swap request ${lang}`, async ({page, openApp, backend}, info) => {
    const mobile = info.project.name === 'mobile';
    backend.raw.months[0].status = 'published';
    await openApp('admin');
    if (lang === 'he') await switchLanguage(page, 'he');
    await tab(page, t('Schedule', 'לוח')).click();
    await page.locator('button[data-date="2026-11-04"]').filter({has: page.locator('.date-line')}).click();
    if (mobile) await page.locator('[data-day-details] .day-duty').click();
    await page.getByRole('dialog').getByRole('button', {name: t('Edit', 'עריכה'), exact: true}).click();
    await expect(page.getByRole('dialog').getByRole('button', {name: t('Review change', 'בדיקת השינוי'), exact: true})).toBeVisible();
    await both(page, `published-edit-${lang}`);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.locator('button[data-date="2026-11-02"]').filter({has: page.locator('.date-line')}).click();
    if (mobile) await page.locator('[data-day-details] .day-duty').click();
    await page.getByRole('dialog').getByRole('button', {name: t('Swap', 'החלפה'), exact: true}).click();
    await expect(page.locator('button[data-date="2026-11-03"]')).toHaveAttribute('data-swap-state', /^(ok|blocked)$/);
    await both(page, `swap-picking-${lang}`);
    await page.locator('button[data-date="2026-11-03"]').filter({has: page.locator('.date-line')}).focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('dialog')).toBeVisible();
    await both(page, `swap-request-${lang}`);
  });

  test(`welcome, access and offline ${lang}`, async ({page, openApp, backend}) => {
    backend.showWelcome = true;
    await openApp('a', undefined, {waitForReady: false});
    await expect(page.getByRole('dialog')).toBeVisible();
    if (lang === 'he') {
      await page.keyboard.press('Escape'); await switchLanguage(page, 'he');
      await page.evaluate(() => localStorage.removeItem('duty-welcome-seen')); await page.reload();
      await expect(page.getByRole('dialog')).toBeVisible();
    }
    await both(page, `welcome-${lang}`);
    await page.keyboard.press('Escape');
    await page.context().setOffline(true);
    await expect(page.locator('.offline-pill')).toBeVisible();
    await both(page, `offline-${lang}`);
    await page.context().setOffline(false);
    backend.showWelcome = false;
    await openApp('signed-out');
    if (lang === 'he') await page.getByRole('button', {name: 'עברית', exact: true}).click();
    await both(page, `access-signed-out-${lang}`);
    await openApp('pending');
    if (lang === 'he') await page.getByRole('button', {name: 'עברית', exact: true}).click();
    await both(page, `access-pending-${lang}`);
  });
}
