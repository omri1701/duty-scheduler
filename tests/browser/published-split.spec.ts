import {test, expect, ids, duty, switchLanguage, openDutySheet, type Backend} from './fixtures';
import type {Page} from '@playwright/test';
import {existsSync} from 'node:fs';

// Split a published weekend (decision 2026-11-07): the draft editor's "One weekend | Two days"
// layout on a published weekend, per-day points, Temporary/Permanent and the copyable summary.
const names: Record<string, string> = {[ids.admin]: 'Avery Admin', [ids.a]: 'Alex Atlas', [ids.b]: 'Blair Birch', [ids.c]: 'Casey Cedar', [ids.d]: 'Drew Dale', [ids.e]: 'Eden Elm'};
const calls = (backend: Backend) => backend.calls.filter(c => c.name === 'duty_edit_published_weekend');
const current = (backend: Backend, day: string) => backend.raw.assignments.find(d => d.publication_id === backend.raw.months[0].current_publication_id && d.day === day)!;
const edit = async (page: Page, day: string) => (await openDutySheet(page, day)).getByRole('button', {name: /^(Edit|עריכה)$/}).click();

/** Gallery capture: light and dark, the same way as the redesign gallery. */
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
async function both(page: Page, name: string) {
  await snapshot(page, name);
  await page.emulateMedia({colorScheme: 'dark'});
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await snapshot(page, `${name}-dark`);
  await page.emulateMedia({colorScheme: 'light'});
}
/** A published weekend already split: Friday 13th Alex, Saturday 14th Blair. */
function splitThirteenth(backend: Backend) {
  backend.raw.assignments = backend.raw.assignments.filter(r => r.day !== '2026-11-13');
  for (const publication of [backend.raw.publications[0].id, null]) backend.raw.assignments.push(
    {id: `fri-${publication ?? 'draft'}`, publication_id: publication, day: '2026-11-13', end_day: '2026-11-14', primary_id: ids.a, secondary_id: null, locked: false, manager_override: false, title: '', extra_points: 0, saturday_extra_points: 0, points: 0.5},
    {id: `sat-${publication ?? 'draft'}`, publication_id: publication, day: '2026-11-14', end_day: '2026-11-15', primary_id: ids.b, secondary_id: null, locked: false, manager_override: false, title: '', extra_points: 0, saturday_extra_points: 0, points: 0.5});
}

test.beforeEach(({backend}) => {backend.raw.months[0].status = 'published';});

for (const lang of ['en', 'he'] as const) test(`split a published weekend: two day cards, per-day points, Temporary debt and summary ${lang}`, async ({page, openApp, backend}) => {
  const t = (en: string, he: string) => lang === 'en' ? en : he;
  const owner = current(backend, '2026-11-06').primary_id!, taker = owner === ids.c ? ids.d : ids.c;
  await openApp();
  if (lang === 'he') await switchLanguage(page, 'he');
  await edit(page, '2026-11-06');
  const dialog = page.locator('.published-edit-dialog');
  await expect(dialog.getByRole('heading', {name: t('Weekend', 'סוף שבוע')})).toBeVisible();
  await expect(dialog.locator('.day-card')).toHaveCount(1);
  // Each date starts at its own points: half the weekend's.
  await expect(dialog.getByLabel(t('Friday points', 'נקודות ביום שישי'))).toHaveValue('0.5');
  await expect(dialog.getByLabel(t('Saturday points', 'נקודות ביום שבת'))).toHaveValue('0.5');
  await both(page, `published-weekend-one-${lang}`);
  // Keyboard: arrows move the layout switch (mirrored in Hebrew).
  await dialog.getByRole('radio', {name: t('One weekend', 'סוף שבוע אחד')}).focus();
  await page.keyboard.press(lang === 'en' ? 'ArrowRight' : 'ArrowLeft');
  await expect(dialog.getByRole('radio', {name: t('Two days', 'שני ימים')})).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.locator('.day-card')).toHaveCount(2);
  await dialog.getByRole('combobox', {name: t('Saturday primary engineer', 'מהנדס ראשי ביום שבת')}).click();
  await page.getByRole('option', {name: names[taker]}).click();
  await dialog.getByLabel(t('Saturday points', 'נקודות ביום שבת')).fill('1');
  await expect(dialog.getByRole('group', {name: t('Compensation', 'פיצוי')})).toBeVisible();
  if (lang === 'en') await expect(dialog).toContainText(`${names[owner]} owes ${names[taker]} 0.5 points (7 Nov), repaid in later months.`);
  await both(page, `published-weekend-two-${lang}`);
  await dialog.getByRole('button', {name: t('Review change', 'בדיקת השינוי')}).click();
  const summary = page.getByLabel(t('Summary', 'סיכום'));
  if (lang === 'en') await expect(summary).toHaveValue(`Duty change (published schedule)\nDate: Fri 06/11/2026 – Sat 07/11/2026\nWeekend: One weekend → Two days\nFri 06/11/2026: ${names[owner]} (unchanged) · 0.5 points\nSat 07/11/2026: ${names[owner]} → ${names[taker]} · 0.5 points → 1 point\nType: Temporary\nBalance Sat 07/11/2026: ${names[owner]} owes ${names[taker]} 0.5 points`);
  else await expect(summary).toHaveValue(new RegExp(`${names[taker]} במקום ${names[owner]}`));
  await snapshot(page, `published-weekend-review-${lang}`);
  await page.getByRole('button', {name: t('Publish change', 'פרסום השינוי')}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(calls(backend).map(c => c.params)).toMatchObject([{p_publication: '20000000-0000-4000-8000-000000000010', p_friday: '2026-11-06', p_friday_primary: owner, p_friday_extra: 0,
    p_saturday_primary: taker, p_saturday_extra: 0.5, p_kind: 'temporary', p_override_reason: ''}]);
  // Each half is now a day of its own on the calendar.
  await expect(duty(page, '2026-11-07')).toBeVisible();
  await snapshot(page, `published-weekend-split-calendar-${lang}`);
});

test('a split half joins back: Keep X / Keep Y, Permanent says no debt, one weekend again', async ({page, openApp, backend}) => {
  splitThirteenth(backend);
  await openApp();
  await edit(page, '2026-11-14');
  const dialog = page.locator('.published-edit-dialog');
  await expect(dialog.locator('.split-row')).toContainText('Part of a split weekend');
  await expect(dialog.getByLabel('Points', {exact: true})).toHaveValue('0.5');
  await snapshot(page, 'published-weekend-half-en');
  await dialog.getByRole('button', {name: 'Join', exact: true}).click();
  await expect(dialog.locator('.keep-option')).toHaveCount(2);
  await expect(dialog.getByRole('button', {name: 'Review change'})).toBeDisabled();
  await snapshot(page, 'published-weekend-keep-en');
  await dialog.getByRole('button', {name: /Keep Alex Atlas/}).click();
  await expect(dialog.locator('.day-card')).toHaveCount(1);
  await dialog.getByRole('button', {name: 'Permanent'}).click();
  await expect(dialog).toContainText('No debt. Each day goes to its new person for good.');
  await dialog.getByRole('button', {name: 'Review change'}).click();
  await expect(page.getByLabel('Summary')).toHaveValue(/Weekend: Two days → One weekend\nFri 13\/11\/2026: Alex Atlas \(unchanged\) · 0.5 points\nSat 14\/11\/2026: Blair Birch → Alex Atlas · 0.5 points\nType: Permanent\nBalance Sat 14\/11\/2026: No debt$/);
  await page.getByRole('button', {name: 'Publish change'}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(calls(backend)[0].params).toMatchObject({p_friday: '2026-11-13', p_friday_primary: ids.a, p_saturday_primary: ids.a, p_kind: 'permanent'});
  // The H1 check asked about both dates.
  expect(backend.calls.filter(c => c.name === 'duty_edit_returns').map(c => c.params.p_day).sort()).toEqual(['2026-11-13', '2026-11-14']);
  await expect(duty(page, '2026-11-13')).toBeVisible();
  await expect(duty(page, '2026-11-14')).toHaveCount(0);
});

test('each half is a normal day: its holder swaps it alone', async ({page, openApp, backend}) => {
  splitThirteenth(backend);
  await openApp('b');
  await (await openDutySheet(page, '2026-11-14')).getByRole('button', {name: 'Swap', exact: true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(duty(page, '2026-11-14')).toHaveAttribute('aria-pressed', 'true');
  await expect(duty(page, '2026-11-13')).not.toHaveAttribute('aria-pressed', 'true');
});

test('reduced motion: the second day card appears without animating; no layout shift on split', async ({page, openApp}) => {
  await page.emulateMedia({reducedMotion: 'reduce'});
  await openApp();
  await edit(page, '2026-11-06');
  const dialog = page.locator('.published-edit-dialog');
  // Within the sheet (a phone sheet grows upwards from the bottom edge).
  const offset = async () => (await dialog.locator('.day-card').first().boundingBox())!.y - (await dialog.boundingBox())!.y;
  const before = await offset();
  await dialog.getByRole('radio', {name: 'Two days'}).click();
  await expect(dialog.locator('.card-split-in')).toHaveCSS('animation-name', 'none');
  // The first card keeps its place: the new card is added below it.
  expect(Math.abs(await offset() - before)).toBeLessThan(1);
});
