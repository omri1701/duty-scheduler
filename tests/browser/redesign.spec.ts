import {test, expect, ids, switchLanguage, monthAction} from './fixtures';
import type {Page} from '@playwright/test';
import {PROJECTS} from '../../lib/supabase/environment';
import {existsSync} from 'node:fs';
import {mockPush, VAPID_PUBLIC_KEY} from './push-mock';

// The redesign gallery (decision 2026-11-06): every screen in light and dark, English and Hebrew.
test.beforeEach(({backend}) => {backend.url = PROJECTS.prod; backend.runtimeOrigin = 'https://duty-scheduler-prod.vercel.app';});

/** `held`: a gesture is in progress, so the pointer stays where it is (moving it would continue the drag). */
async function snapshot(page: Page, name: string, held = false) {
  test.info().annotations.push({type: 'visual-review', description: JSON.stringify({name: name + '.png', viewport: page.viewportSize(), language: await page.locator('html').getAttribute('lang')})});
  await page.evaluate(() => document.fonts.ready);
  if (!held) await page.mouse.move(0, 0);
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
    await both(page, `team-inactive-group-${lang}`);
    if (info.project.name === 'mobile') {
      const row = page.locator(`[data-member="${ids.b}"] .swipe-content`);
      const box = (await row.boundingBox())!;
      // The action sits at the inline end, so the row is dragged toward the inline start.
      const dir = lang === 'he' ? 1 : -1, x = box.x + box.width * .6, y = box.y + box.height / 2;
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dir * 30, y, {steps: 3}); await page.mouse.move(x + dir * 80, y, {steps: 5}); await page.mouse.up();
      await expect(page.locator(`[data-member="${ids.b}"]`)).toHaveClass(/swipe-open/);
      await both(page, `team-swipe-${lang}`);
      await page.locator(`[data-member="${ids.b}"] .swipe-action`).click();
      await expect(page.locator(`[data-member="${ids.b}"]`)).toHaveClass(/inactive/);
      // The deactivation toast leaves before the member sheet is captured.
      await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, {timeout: 15_000});
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
    // Owner round 4: a Thu–Sat bar (19–21 Nov), whose name must stay readable over swap targets.
    for (const r of backend.raw.assignments.filter(r => ['2026-11-19', '2026-11-20'].includes(r.day))) r.primary_id = ids.e;
    await openApp('admin');
    if (lang === 'he') await switchLanguage(page, 'he');
    await tab(page, t('Schedule', 'לוח')).click();
    await page.locator('button[data-date="2026-11-04"]').filter({has: page.locator('.date-line')}).click();
    if (mobile) await page.locator('[data-day-details] .day-duty').click();
    await page.getByRole('dialog').getByRole('button', {name: t('Edit', 'עריכה'), exact: true}).click();
    await expect(page.getByRole('dialog').getByRole('button', {name: t('Review change', 'בדיקת השינוי'), exact: true})).toBeVisible();
    await both(page, `published-edit-sheet-${lang}`);
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

// Remaining dialogs: Publish, Cancel draft, Constraints deadline, Delete version, Add temporary
// member, the activity bell, swap consent, and the declined / inactive access screens.
for (const lang of ['en', 'he'] as const) {
  const t = (en: string, he: string) => lang === 'en' ? en : he;

  test(`month dialogs, team dialog and bell ${lang}`, async ({page, openApp, backend}) => {
    backend.raw.swapRequests = [{
      id: 'request-approved', month: '2026-11', source_publication_id: backend.raw.publications[0].id, requester_id: ids.b, other_id: ids.a,
      from_day: '2026-11-03', from_end_day: '2026-11-04', to_day: '2026-11-02', to_end_day: '2026-11-03', explanation: '', status: 'approved',
      accepted_by: ids.a, accepted_at: '2026-10-08T10:00:00Z', created_at: '2026-10-08T09:00:00Z', resolved_at: '2026-10-09T08:00:00Z', resolved_by: ids.admin, result_publication_id: null, override_reason: '',
    }];
    await openApp('admin');
    if (lang === 'he') await switchLanguage(page, 'he');
    await page.locator('[data-bell]').click();
    await expect(page.locator('.bell-list')).toBeVisible();
    await both(page, `bell-${lang}`);
    await page.keyboard.press('Escape');
    await tab(page, t('Schedule', 'לוח')).click();
    await page.getByRole('button', {name: t('Publish', 'פרסום'), exact: true}).click();
    await expect(page.getByRole('dialog', {name: t('Publish?', 'לפרסם?')})).toBeVisible();
    await both(page, `publish-${lang}`);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await monthAction(page, t('Cancel draft', 'ביטול טיוטה'));
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await both(page, `cancel-draft-${lang}`);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog')).toBeHidden();
    await monthAction(page, t('Constraints deadline', 'מועד אחרון לאילוצים'));
    await expect(page.getByRole('dialog')).toBeVisible();
    await both(page, `deadline-${lang}`);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await monthAction(page, t('Versions', 'גרסאות'));
    await page.getByRole('dialog').getByRole('button', {name: t('Delete version', 'מחיקת גרסה'), exact: true}).click();
    await expect(page.getByRole('dialog').getByRole('button', {name: t('Confirm', 'אישור'), exact: true})).toBeVisible();
    await both(page, `versions-delete-${lang}`);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await tab(page, t('Team', 'צוות')).click();
    await page.getByRole('button', {name: t('Add temporary', 'הוספת זמני'), exact: true}).click();
    await expect(page.getByRole('dialog', {name: t('Add temporary member', 'הוספת חבר זמני')})).toBeVisible();
    await both(page, `temporary-member-${lang}`);
  });

  test(`swap consent and declined or inactive access ${lang}`, async ({page, openApp, backend}) => {
    backend.raw.months[0].status = 'published';
    backend.raw.constraints.push({member_id: ids.a, day: '2026-11-03', kind: 'no', note: 'Synthetic appointment'});
    backend.raw.swapRequests = [{
      id: 'request-conflict', month: '2026-11', source_publication_id: backend.raw.publications[0].id, requester_id: ids.b, other_id: ids.a,
      from_day: '2026-11-03', from_end_day: '2026-11-04', to_day: '2026-11-02', to_end_day: '2026-11-03', explanation: 'Family event', status: 'awaiting_engineer',
      accepted_by: null, accepted_at: null, created_at: '2026-10-09T09:00:00Z', resolved_at: null, resolved_by: null, result_publication_id: null, override_reason: '',
    }];
    await openApp('a');
    if (lang === 'he') await switchLanguage(page, 'he');
    await page.locator('[data-swap-card]').getByRole('button', {name: t('Accept', 'קבלה'), exact: true}).click();
    await expect(page.getByRole('dialog', {name: t('Accept despite a conflict?', 'לאשר למרות התנגשות?')})).toBeVisible();
    await both(page, `swap-consent-${lang}`);
    await page.keyboard.press('Escape');
    await openApp('rejected');
    if (lang === 'he') await page.getByRole('button', {name: 'עברית', exact: true}).click();
    await both(page, `access-declined-${lang}`);
    await openApp('inactive');
    if (lang === 'he') await page.getByRole('button', {name: 'עברית', exact: true}).click();
    await both(page, `access-inactive-${lang}`);
  });
}

// The weekend editor (decision 2026-11-07): one weekend, two days, the keep choice, a split half,
// the calendar with a split weekend and Plan the month's split notice.
for (const lang of ['en', 'he'] as const) {
  const t = (en: string, he: string) => lang === 'en' ? en : he;
  test(`weekend editor and split weekends ${lang}`, async ({page, openApp, backend}) => {
    backend.raw.assignments = backend.raw.assignments.filter(r => r.day !== '2026-11-13');
    for (const publication of [backend.raw.publications[0].id, null]) backend.raw.assignments.push(
      {id: `fri-${publication ?? 'draft'}`, publication_id: publication, day: '2026-11-13', end_day: '2026-11-14', primary_id: ids.a, secondary_id: null, locked: false, manager_override: false, title: '', extra_points: 0, saturday_extra_points: 0, points: 0.5},
      {id: `sat-${publication ?? 'draft'}`, publication_id: publication, day: '2026-11-14', end_day: '2026-11-15', primary_id: ids.b, secondary_id: null, locked: false, manager_override: false, title: '', extra_points: 0, saturday_extra_points: 0, points: 0.5});
    await openApp('admin');
    if (lang === 'he') await switchLanguage(page, 'he');
    await tab(page, t('Schedule', 'לוח')).click();
    await expect(page.locator('.calendar-grid')).toBeVisible();
    await both(page, `schedule-split-${lang}`);
    const open = async (day: string) => {
      const cell = page.locator(`button[data-date="${day}"]`).filter({has: page.locator('.date-line')}), details = page.locator('[data-day-details] .day-duty');
      if (!await cell.evaluate(el => el.classList.contains('selected-day'))) await cell.click();
      await expect(page.getByRole('dialog').or(details)).toBeVisible();
      if (await details.isVisible()) await details.click();
      await page.getByRole('dialog').getByRole('button', {name: t('Edit', 'עריכה'), exact: true}).click();
      await expect(page.locator('.duty-dialog')).toBeVisible();
    };
    const dialog = page.locator('.duty-dialog');
    await open('2026-11-06');
    await both(page, `weekend-one-${lang}`);
    await dialog.getByRole('radio', {name: t('Two days', 'שני ימים'), exact: true}).click();
    await expect(dialog.locator('.day-card')).toHaveCount(2);
    await both(page, `weekend-two-${lang}`);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await open('2026-11-14');
    await expect(dialog.locator('.split-row')).toBeVisible();
    await both(page, `weekend-half-${lang}`);
    await dialog.getByRole('button', {name: t('Join', 'איחוד'), exact: true}).click();
    await expect(dialog.locator('.keep-option')).toHaveCount(2);
    await both(page, `weekend-keep-${lang}`);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    const primary = page.locator('.month-primary'), plan = t('Plan the month', 'תכנון החודש');
    if (await primary.getAttribute('aria-label') === plan) await primary.click(); else await monthAction(page, plan);
    await expect(page.locator('[data-split-note]')).toBeVisible();
    await expect(page.locator('.allocation-dialog .plan-rows')).toBeVisible();
    await page.mouse.move(0, 0);
    await both(page, `plan-split-${lang}`);
  });
}

// Owner round 3: the month swipe mid-gesture (the real neighbour month, blurred) and a notched phone.
for (const lang of ['en', 'he'] as const) {
  const t = (en: string, he: string) => lang === 'en' ? en : he;
  test(`month swipe mid-gesture and safe areas ${lang}`, async ({page, openApp, backend}, info) => {
    const mobile = info.project.name === 'mobile';
    backend.raw.months.push({month: '2026-12', deadline: '2026-11-24', status: 'draft', generated: true, current_publication_id: null, publication_sequence: 0});
    backend.raw.assignments.push({id: 'dec-weekend', publication_id: null, day: '2026-12-04', end_day: '2026-12-06', primary_id: ids.a, secondary_id: null, manager_override: false, title: '', extra_points: 0, points: 1});
    await openApp('admin');
    if (lang === 'he') await switchLanguage(page, 'he');
    await tab(page, t('Schedule', 'לוח')).click();
    const grid = (await page.locator('.calendar-grid').first().boundingBox())!, head = (await page.locator('.calendar-weekdays:visible').first().boundingBox())!;
    const x = grid.x + grid.width / 2, y = mobile ? grid.y + 20 : head.y + head.height / 2, dx = (lang === 'he' ? 1 : -1) * grid.width * .35;
    const cdp = mobile ? await page.context().newCDPSession(page) : null;
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y}]});
      for (let step = 1; step <= 6; step++) await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: x + dx * step / 6, y}]});
    } else {await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y, {steps: 6});}
    await expect(page.locator('.month-peek .calendar-grid')).toBeVisible();
    // Captured light only: the gesture is held while the screenshot is taken.
    await snapshot(page, `month-swipe-${lang}`, true);
    // Back to the start before lifting, so the held capture never turns into a flick.
    if (cdp) {await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x, y}]}); await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []}); await cdp.detach();} else {await page.mouse.move(x, y, {steps: 6}); await page.mouse.up();}
    await expect(page.locator('.month-peek')).toHaveCount(0);
    // Owner round 4: the name swipes on its own (the calendar stays still) ...
    const hold = async (fx: number, fy: number, by: number) => {
      const touch = mobile ? await page.context().newCDPSession(page) : null;
      if (touch) {
        await touch.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: fx, y: fy}]});
        for (let step = 1; step <= 6; step++) await touch.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: fx + by * step / 6, y: fy}]});
      } else {await page.mouse.move(fx, fy); await page.mouse.down(); await page.mouse.move(fx + by, fy, {steps: 6});}
      return async () => {
        if (touch) {await touch.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: fx, y: fy}]}); await touch.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []}); await touch.detach();}
        else {await page.mouse.move(fx, fy, {steps: 6}); await page.mouse.up();}
      };
    };
    const name = (await page.locator('.month-bar .month-name').boundingBox())!;
    let release = await hold(name.x + name.width / 2, name.y + name.height / 2, (lang === 'he' ? 1 : -1) * 40);
    await expect(page.locator('.month-name-peek')).toBeVisible();
    await snapshot(page, `month-name-swipe-${lang}`, true);
    await release();
    await expect(page.locator('.month-name-peek')).toHaveCount(0);
    // ... and a six-week month (January 2027) peeks in whole, the calendar grown to fit it.
    await page.getByRole('button', {name: t('Next month', 'חודש הבא'), exact: true}).click();
    await expect(page.locator('.month-bar .month-name')).toHaveText(t('December 2026', 'דצמבר 2026'));
    await expect(page.locator('.month-peek')).toHaveCount(0);
    release = await hold(x, y, dx);
    await expect(page.locator('.month-peek [data-date="2027-01-31"]')).toBeVisible();
    await snapshot(page, `month-swipe-six-weeks-${lang}`, true);
    await release();
    await expect(page.locator('.month-peek')).toHaveCount(0);
    await page.getByRole('button', {name: t('Previous month', 'חודש קודם'), exact: true}).click();
    await expect(page.locator('.month-bar .month-name')).toHaveText(t('November 2026', 'נובמבר 2026'));
    if (!mobile) return;
    await page.evaluate(() => {document.documentElement.dataset.safeArea = 'test';});
    await both(page, `safe-area-schedule-${lang}`);
    await page.locator('[data-settings-button]').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await both(page, `safe-area-settings-${lang}`);
  });
}
