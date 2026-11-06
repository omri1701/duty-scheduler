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
