import {test, expect, monthAction, duty, ids, targetReady, switchLanguage} from './fixtures';
import type {Page} from '@playwright/test';
import {PROJECTS} from '../../lib/supabase/environment';
import {existsSync} from 'node:fs';

// Scenario captures (the screens themselves are in redesign.spec.ts): today's accent, streak
// bars, swap hints and proposals, the published edit summary, Clear board, the plan after
// Generate, non-weekend members and the calendar subscription states.
test.beforeEach(({backend}) => {backend.url = PROJECTS.prod; backend.runtimeOrigin = 'https://duty-scheduler-prod.vercel.app';});

async function snapshot(page: Page, name: string, keepPointer = false) {
  test.info().annotations.push({type: 'visual-review', description: JSON.stringify({name: name + '.png', viewport: page.viewportSize(), language: await page.locator('html').getAttribute('lang')})});
  await page.evaluate(() => document.fonts.ready);
  if (!keepPointer) await page.mouse.move(0, 0);
  // With updateSnapshots:none Playwright reports missing references without an actual attachment. Retain the candidate explicitly for the review gallery.
  if (!existsSync(test.info().snapshotPath(name + '.png'))) {
    const path = test.info().outputPath(name + '-actual.png');
    await page.screenshot({path, fullPage: true, animations: 'disabled', caret: 'hide'});
    await test.info().attach(name + '-actual.png', {path, contentType: 'image/png'});
  }
  await expect.soft(page).toHaveScreenshot(name + '.png', {fullPage: true});
}
const schedule = async (page: Page, lang: 'en' | 'he') => {await page.getByRole('tab', {name: lang === 'en' ? 'Schedule' : 'לוח', exact: true}).click(); await expect(page.locator('.calendar-grid')).toBeVisible();};
/** Opens a duty's sheet: a tap on PC, the day row on phones. */
async function openDuty(page: Page, day: string) {
  await duty(page, day).click();
  if (test.info().project.name === 'mobile') await page.locator('[data-day-details] .day-duty').click();
  await expect(page.getByRole('dialog')).toBeVisible();
}
/** Starts a published swap from a duty and waits until the target's availability is known. */
async function pickSwap(page: Page, from: string, to: string, lang: 'en' | 'he') {
  await openDuty(page, from);
  await page.getByRole('dialog').getByRole('button', {name: lang === 'en' ? 'Swap' : 'החלפה', exact: true}).click();
  await targetReady(page, to);
}

for (const lang of ['en', 'he'] as const) test(`today accent in combined weekend ${lang}`, async ({page, openApp}) => {
  await openApp();
  await page.clock.setFixedTime(new Date('2026-11-07T12:00:00Z'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  if (lang === 'he') await switchLanguage(page, 'he');
  await schedule(page, lang);
  await expect(duty(page, '2026-11-06').locator('[aria-current="date"]')).toHaveText('7');
  await snapshot(page, `today-weekend-draft-${lang}`);
  await page.getByRole('radio', {name: lang === 'en' ? 'Published' : 'פורסם', exact: true}).click();
  await snapshot(page, `today-weekend-published-${lang}`);
});

for (const lang of ['en', 'he'] as const) test(`streak bars and locked holiday marks ${lang}`, async ({page, openApp, backend}, info) => {
  const rows = (day: string) => backend.raw.assignments.filter(r => r.day === day);
  // Thu 5 → weekend 6–7 → Sun 8 → Mon 9 is one member's streak across the Saturday→Sunday row break.
  for (const day of ['2026-11-05', '2026-11-06', '2026-11-08', '2026-11-09']) for (const r of rows(day)) r.primary_id = ids.b;
  for (const day of ['2026-11-04', '2026-11-10']) for (const r of rows(day)) r.primary_id = ids.d;
  // A locked holiday weekend and a locked holiday weekday carry the lock, the dates and the +extra together.
  for (const day of ['2026-11-12', '2026-11-20']) for (const r of rows(day)) r.locked = true;
  // A hand-split 27–28 weekend: each half centres its own name. Thursday 26 is someone else's so the halves stand alone.
  for (const r of rows('2026-11-26')) r.primary_id = ids.a;
  backend.raw.assignments = backend.raw.assignments.filter(r => r.day !== '2026-11-27');
  for (const publication of [backend.raw.publications[0].id, null]) backend.raw.assignments.push(
    {id: `split-fri-${publication ?? 'draft'}`, publication_id: publication, day: '2026-11-27', end_day: '2026-11-28', primary_id: ids.d, secondary_id: null, locked: false, manager_override: false, title: '', extra_points: 0, saturday_extra_points: 0, points: 0.5},
    {id: `split-sat-${publication ?? 'draft'}`, publication_id: publication, day: '2026-11-28', end_day: '2026-11-29', primary_id: ids.e, secondary_id: null, locked: false, manager_override: false, title: '', extra_points: 0, saturday_extra_points: 0, points: 0.5});
  await openApp();
  if (lang === 'he') await switchLanguage(page, 'he');
  await schedule(page, lang);
  await snapshot(page, `streaks-${lang}`);
  await page.emulateMedia({colorScheme: 'dark'});
  await snapshot(page, `streaks-dark-${lang}`);
  if (info.project.name !== 'mobile') return;
  await page.emulateMedia({colorScheme: 'light'});
  await page.setViewportSize({width: 320, height: 844});
  await snapshot(page, `streaks-320-${lang}`);
});

// Decision 2026-11-05: a day the server would refuse is greyed before the pick; usable days stay green.
for (const lang of ['en', 'he'] as const) test(`swap target hints ${lang}`, async ({page, openApp, backend}) => {
  backend.raw.constraints.push({member_id: ids.b, day: '2026-11-09', kind: 'no', note: 'Synthetic private note'});
  await openApp('a');
  if (lang === 'he') await switchLanguage(page, 'he');
  await schedule(page, lang);
  await pickSwap(page, '2026-11-09', '2026-11-05', lang);
  await expect(duty(page, '2026-11-04')).toHaveClass(/swap-blocked/);
  await expect(duty(page, '2026-11-03')).toHaveClass(/swap-blocked/);
  await expect(duty(page, '2026-11-05')).toHaveClass(/drag-target/);
  await snapshot(page, `swap-target-hints-${lang}`);
});

for (const lang of ['en', 'he'] as const) test(`admin swap proposal, cards and approval summary ${lang}`, async ({page, openApp, backend}) => {
  const t = (en: string, he: string) => lang === 'en' ? en : he;
  await openApp('admin');
  if (lang === 'he') await switchLanguage(page, 'he');
  await schedule(page, lang);
  await page.getByRole('radio', {name: t('Published', 'פורסם'), exact: true}).click();
  await pickSwap(page, '2026-11-02', '2026-11-03', lang);
  await duty(page, '2026-11-03').focus(); await page.keyboard.press('Space');
  await expect(page.getByRole('button', {name: t('Send to both', 'שליחה לשניהם'), exact: true})).toBeEnabled();
  await snapshot(page, `admin-swap-proposal-${lang}`);
  await page.getByRole('button', {name: t('Send to both', 'שליחה לשניהם'), exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, {timeout: 10_000});
  await page.getByRole('tab', {name: t('Home', 'בית'), exact: true}).click();
  await expect(page.locator('[data-swap-card]')).toBeVisible();
  await snapshot(page, `admin-swap-proposed-${lang}`);
  // Both accepted; Blair later marked 2 November unavailable.
  Object.assign(backend.raw.swapRequests![0], {status: 'awaiting_admin', accepted_by: ids.b, accepted_at: '2026-10-09T10:00:00Z', requester_accepted_at: '2026-10-09T10:00:00Z'});
  backend.raw.constraints.push({member_id: ids.b, day: '2026-11-02', kind: 'no', note: 'Synthetic late note'});
  backend.raw.revision!++;
  await page.reload();
  if (lang === 'he') await switchLanguage(page, 'he');
  await page.locator('[data-swap-card]').getByRole('button', {name: t('Approve', 'אישור'), exact: true}).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  await snapshot(page, `admin-swap-approval-${lang}`);
});

for (const lang of ['en', 'he'] as const) test(`manager states: published, new, reopened and cancel draft ${lang}`, async ({page, openApp, backend}) => {
  backend.raw.months[0].status = 'published';
  await openApp();
  if (lang === 'he') await switchLanguage(page, 'he');
  await schedule(page, lang);
  const button = (en: string, he: string) => page.getByRole('button', {name: lang === 'en' ? en : he, exact: true});
  await snapshot(page, `manager-published-${lang}`);
  await button('Next month', 'חודש הבא').click();
  await snapshot(page, `manager-new-${lang}`);
  await button('Previous month', 'חודש קודם').click();
  await button('Reopen', 'פתיחה לעריכה').click();
  await page.getByRole('radio', {name: lang === 'en' ? 'Published' : 'פורסם', exact: true}).click();
  await snapshot(page, `manager-reopened-published-${lang}`);
  await monthAction(page, lang === 'en' ? 'Cancel draft' : 'ביטול טיוטה');
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await snapshot(page, `manager-cancel-draft-${lang}`);
});

for (const lang of ['en', 'he'] as const) test(`manager clear board ${lang}`, async ({page, openApp, backend}) => {
  for (const r of backend.raw.assignments) if (!r.publication_id && ['2026-11-02', '2026-11-20'].includes(r.day)) r.locked = true;
  await openApp();
  if (lang === 'he') await switchLanguage(page, 'he');
  await schedule(page, lang);
  const label = lang === 'en' ? 'Clear board' : 'ניקוי הלוח';
  await monthAction(page, label);
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await snapshot(page, `manager-clear-board-${lang}`);
  await page.getByRole('alertdialog').getByRole('button', {name: label, exact: true}).click();
  await expect(page.getByRole('alertdialog')).toBeHidden();
  await expect(page.getByRole('button', {name: lang === 'en' ? 'Undo' : 'שחזור', exact: true})).toBeVisible();
  await snapshot(page, `manager-cleared-board-${lang}`);
});

for (const lang of ['en', 'he'] as const) test(`published duty edit and summary ${lang}`, async ({page, openApp, backend}) => {
  backend.raw.months[0].status = 'published';
  await openApp();
  if (lang === 'he') await switchLanguage(page, 'he');
  await schedule(page, lang);
  const t = (en: string, he: string) => lang === 'en' ? en : he;
  await openDuty(page, '2026-11-04');
  await page.getByRole('dialog').getByRole('button', {name: t('Edit', 'עריכה'), exact: true}).click();
  await page.getByRole('combobox', {name: t('Engineer', 'מהנדס'), exact: true}).click();
  await page.getByRole('option', {name: t('Alex Atlas · unavailable', 'Alex Atlas · לא זמין'), exact: true}).click();
  await page.getByRole('checkbox', {name: t('Override availability as admin', 'חריגה מאילוץ כמנהל')}).check();
  await page.getByLabel(t('Required audit reason', 'נימוק חובה לתיעוד')).fill('Covering a family event');
  await snapshot(page, `published-edit-${lang}`);
  await page.getByRole('button', {name: t('Review change', 'בדיקת השינוי'), exact: true}).click();
  await snapshot(page, `published-edit-summary-${lang}`);
});

for (const lang of ['en', 'he'] as const) test(`plan the month pie ${lang}`, async ({page, openApp, backend}, info) => {
  backend.raw.assignments = []; backend.raw.publications = [];
  backend.raw.months[0] = {...backend.raw.months[0], current_publication_id: null, status: 'draft', generated: false};
  // One locked duty, so the pie total and the hover details both show locked points.
  backend.raw.assignments.push({id: 'locked', publication_id: null, day: '2026-11-10', end_day: '2026-11-11', primary_id: ids.admin, secondary_id: null, title: '', extra_points: 0, points: 1, locked: true, manager_override: false});
  await openApp();
  const he = lang === 'he', dialog = page.getByRole('dialog');
  if (he) await switchLanguage(page, 'he');
  await schedule(page, lang);
  await page.getByRole('button', {name: he ? 'תכנון החודש' : 'Plan the month', exact: true}).first().click();
  await expect(dialog.getByRole('button', {name: he ? 'אישור ושיבוץ' : 'Confirm & generate', exact: true})).toBeEnabled({timeout: 30_000});
  await page.mouse.move(0, 0);
  await expect(dialog.locator('.plan-pie-total small')).toHaveText(he ? '1 נעולות' : '1 locked');
  // A temporary change shows its chip; the pie centre shows the slice in focus.
  await dialog.getByRole('button', {name: `${he ? 'הפחתת זמני' : 'Decrease Temporary'} · Avery Admin`, exact: true}).click();
  const slice = dialog.locator(`.plan-slice[data-engineer="${ids.admin}"]`);
  if (info.project.name === 'mobile') await slice.tap(); else await slice.hover();
  await expect(slice).toHaveClass(/active/);
  await snapshot(page, `plan-month-pie-hover-${lang}`, true);
  await dialog.getByRole('button', {name: he ? 'שמירה' : 'Save', exact: true}).click();
  await expect(dialog.getByRole('button', {name: he ? 'נשמר' : 'Saved', exact: true})).toBeDisabled();
  await dialog.locator('.allocation-details summary').click();
  await dialog.locator('.sheet-body').evaluate(el => {el.scrollTop = el.scrollHeight;});
  await snapshot(page, `plan-month-details-${lang}`);
});

// Non-weekend members (decision 2026-11-01): the Team setting, and the plan's note and kept-lock warning.
for (const lang of ['en', 'he'] as const) test(`non-weekend member ${lang}`, async ({page, openApp, backend}) => {
  backend.raw.assignments = []; backend.raw.publications = [];
  backend.raw.months[0] = {...backend.raw.months[0], current_publication_id: null, status: 'draft', generated: false};
  backend.raw.members.find(m => m.id === ids.e)!.no_weekends = true;
  backend.raw.assignments.push({id: 'locked-weekend', publication_id: null, day: '2026-11-06', end_day: '2026-11-08', primary_id: ids.e, secondary_id: null, title: '', extra_points: 0, points: 1, locked: true, manager_override: false});
  await openApp();
  const he = lang === 'he', dialog = page.getByRole('dialog');
  if (he) await switchLanguage(page, 'he');
  await page.getByRole('tab', {name: he ? 'צוות' : 'Team', exact: true}).click();
  await page.locator(`[data-member="${ids.e}"] .team-row-inner`).click();
  await expect(dialog).toBeVisible();
  await snapshot(page, `team-no-weekends-${lang}`);
  await page.keyboard.press('Escape');
  await schedule(page, lang);
  await page.getByRole('button', {name: he ? 'תכנון החודש' : 'Plan the month', exact: true}).first().click();
  await expect(dialog.getByRole('button', {name: he ? 'אישור ושיבוץ' : 'Confirm & generate', exact: true})).toBeEnabled({timeout: 30_000});
  await page.mouse.move(0, 0);
  await dialog.locator(`.plan-row[data-engineer="${ids.e}"]`).scrollIntoViewIfNeeded();
  await snapshot(page, `plan-month-no-weekends-${lang}`);
});

/** A clipped reference: Generate's fresh seed varies the calendar, so only the deterministic plan and bar areas are compared. */
async function region(page: Page, name: string, clip: {x: number; y: number; width: number; height: number}) {
  test.info().annotations.push({type: 'visual-review', description: JSON.stringify({name: name + '.png', viewport: page.viewportSize(), language: await page.locator('html').getAttribute('lang')})});
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  if (!existsSync(test.info().snapshotPath(name + '.png'))) {
    const path = test.info().outputPath(name + '-actual.png');
    await page.screenshot({path, clip, fullPage: true, animations: 'disabled', caret: 'hide'});
    await test.info().attach(name + '-actual.png', {path, contentType: 'image/png'});
  }
  await expect.soft(page).toHaveScreenshot(name + '.png', {clip, fullPage: true});
}

for (const lang of ['en', 'he'] as const) test(`after Generate the plan is the review ${lang}`, async ({page, openApp, backend}) => {
  backend.raw.assignments = []; backend.raw.publications = [];
  backend.raw.months[0] = {...backend.raw.months[0], current_publication_id: null, status: 'draft', generated: false};
  await openApp();
  const he = lang === 'he', dialog = page.getByRole('dialog');
  if (he) await switchLanguage(page, 'he');
  await schedule(page, lang);
  await page.getByRole('button', {name: he ? 'תכנון החודש' : 'Plan the month', exact: true}).first().click();
  const confirm = dialog.getByRole('button', {name: he ? 'אישור ושיבוץ' : 'Confirm & generate', exact: true});
  await expect(confirm).toBeEnabled({timeout: 30_000});
  await confirm.click();
  await expect(dialog).toBeHidden({timeout: 50_000});
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, {timeout: 15_000});
  // A saved plan change after Generate: Avery takes one point less.
  await monthAction(page, he ? 'תכנון החודש' : 'Plan the month');
  await expect(confirm).toBeEnabled({timeout: 30_000});
  await dialog.getByRole('button', {name: `${he ? 'הפחתת זמני' : 'Decrease Temporary'} · Avery Admin`, exact: true}).click();
  await dialog.getByRole('button', {name: he ? 'שמירה' : 'Save', exact: true}).click();
  await expect(dialog.getByRole('button', {name: he ? 'נשמר' : 'Saved', exact: true})).toBeDisabled();
  await expect(dialog.locator('.allocation-row-warning')).not.toHaveCount(0);
  await region(page, `plan-review-${lang}`, (await dialog.boundingBox())!);
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, {timeout: 15_000});
  const note = page.locator('[data-publish-blocked]');
  await expect(note).toBeVisible();
  const top = (await page.locator('.month-bar').boundingBox())!, bottom = (await note.boundingBox())!;
  await region(page, `publish-waits-${lang}`, {x: 0, y: top.y, width: page.viewportSize()!.width, height: bottom.y + bottom.height - top.y + 8});
});

// Subscribe to my calendar (decision 2026-11-06): new, ready and reset-confirm states.
for (const lang of ['en', 'he'] as const) test(`calendar subscription ${lang}`, async ({page, openApp}) => {
  await openApp('a');
  const he = lang === 'he';
  if (he) await switchLanguage(page, 'he');
  await page.locator('[data-settings-button]').click();
  const section = page.getByRole('region', {name: he ? 'הרשמה ללוח השנה שלי' : 'Subscribe to my calendar'});
  await expect(section.getByRole('button', {name: he ? 'יצירת קישור ללוח השנה שלי' : 'Create my calendar link'})).toBeVisible();
  await section.scrollIntoViewIfNeeded();
  await snapshot(page, `calendar-subscription-new-${lang}`);
  await section.getByRole('button', {name: he ? 'יצירת קישור ללוח השנה שלי' : 'Create my calendar link'}).click();
  await expect(section.getByRole('link', {name: he ? 'הוספה ליומן Apple' : 'Add to Apple Calendar'})).toBeVisible();
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, {timeout: 10_000});
  await snapshot(page, `calendar-subscription-ready-${lang}`);
  await section.getByRole('button', {name: he ? 'איפוס הקישור' : 'Reset link'}).click();
  await expect(section.getByRole('group')).toBeVisible();
  await snapshot(page, `calendar-subscription-reset-${lang}`);
});
