import type {Page} from '@playwright/test';
import {test, expect, duty, ids, type Backend, switchLanguage, monthAction, openDutySheet} from './fixtures';

// The weekend editor (decision 2026-11-07): one card with "One weekend | Two days", two day cards
// in the same sheet, a split half as a regular day with Join, and Plan the month's split notice.
const name = (backend: Backend, id: string) => backend.raw.members.find(m => m.id === id)!.name;
const draftRows = (backend: Backend, days: string[]) => backend.raw.assignments.filter(r => r.publication_id === null && days.includes(r.day)).sort((x, y) => x.day.localeCompare(y.day));
/** Hand-split the 13–14 November weekend in both the published copy and the draft. */
function split(backend: Backend, fri: string, sat: string, locked: {fri?: boolean; sat?: boolean} = {}) {
  backend.raw.assignments = backend.raw.assignments.filter(r => r.day !== '2026-11-13');
  for (const publication of [backend.raw.publications[0].id, null]) backend.raw.assignments.push(
    {id: `fri-${publication ?? 'draft'}`, publication_id: publication, day: '2026-11-13', end_day: '2026-11-14', primary_id: fri, secondary_id: null, locked: !!locked.fri, manager_override: false, title: '', extra_points: 0, saturday_extra_points: 0, points: 0.5},
    {id: `sat-${publication ?? 'draft'}`, publication_id: publication, day: '2026-11-14', end_day: '2026-11-15', primary_id: sat, secondary_id: null, locked: !!locked.sat, manager_override: false, title: '', extra_points: 0, saturday_extra_points: 0, points: 0.5});
}
const edit = async (page: Page, day: string) => {await (await openDutySheet(page, day)).getByRole('button', {name: /^(Edit|עריכה)$/}).click(); await expect(page.locator('.duty-dialog')).toBeVisible();};
async function save(page: Page) {
  const dialog = page.locator('.duty-dialog'), approve = dialog.getByRole('checkbox');
  if (await approve.isVisible()) await approve.check();
  await dialog.getByRole('button', {name: /^(Save assignment|שמירת השיבוץ)$/}).click();
  await expect(dialog).toBeHidden();
}
async function pick(page: Page, label: string, who: string) {
  await page.locator('.duty-dialog').getByRole('combobox', {name: label, exact: true}).click();
  await page.getByRole('option', {name: new RegExp(`^${who}`)}).click();
}

test('taps open combined, split and holiday weekends; a second phone tap clears the day and the next opens it again', async ({page, backend, openApp}, info) => {
  split(backend, ids.a, ids.b);
  await openApp();
  for (const day of ['2026-11-06', '2026-11-13', '2026-11-14', '2026-11-20']) {
    const sheet = await openDutySheet(page, day);
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
  }
  if (info.project.name !== 'mobile') return;
  const details = page.locator('[data-day-details]');
  for (const day of ['2026-11-06', '2026-11-14', '2026-11-20']) {
    await duty(page, day).click();
    await expect(duty(page, day)).toHaveClass(/selected-day/);
    await expect(details.locator('.day-duty')).toBeVisible();
    await duty(page, day).click();
    await expect(details).toHaveCount(0);
    await duty(page, day).click();
    await expect(details.locator('.day-duty')).toBeVisible();
    // Reopening after an edit: the day stays selected, so its row (not another tap) opens it.
    await edit(page, day);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(details.locator('.day-duty')).toBeVisible();
  }
});

for (const lang of ['en', 'he'] as const) test(`Two days splits the weekend in the same sheet; different people stay two regular day chips ${lang}`, async ({page, backend, openApp}) => {
  const he = lang === 'he', fri = draftRows(backend, ['2026-11-06'])[0].primary_id!, other = [ids.d, ids.c].find(id => id !== fri)!;
  await openApp();
  if (he) await switchLanguage(page, 'he');
  await edit(page, '2026-11-06');
  const dialog = page.locator('.duty-dialog');
  await expect(page.getByRole('dialog', {name: he ? 'סוף שבוע' : 'Weekend', exact: true})).toBeVisible();
  await expect(dialog.locator('.day-card')).toHaveCount(1);
  await dialog.getByRole('radio', {name: he ? 'שני ימים' : 'Two days', exact: true}).click();
  await expect(dialog.locator('.day-card')).toHaveCount(2);
  // Both halves start with the weekend's person.
  await expect(dialog.getByRole('combobox', {name: he ? 'מהנדס ראשי ביום שבת' : 'Saturday primary engineer', exact: true})).toHaveText(name(backend, fri));
  await expect(dialog.locator('.day-card').nth(1)).toContainText(he ? '0.5 נק׳' : '0.5 pt');
  await pick(page, he ? 'מהנדס ראשי ביום שבת' : 'Saturday primary engineer', name(backend, other));
  // Back to one weekend with different people: choose who keeps it, with the points it moves.
  await dialog.getByRole('radio', {name: he ? 'סוף שבוע אחד' : 'One weekend', exact: true}).click();
  const keep = dialog.locator('.keep-option');
  await expect(keep).toHaveCount(2);
  await expect(keep.nth(0)).toContainText(`${name(backend, other)} −0.5`);
  await expect(keep.nth(1)).toContainText(`${name(backend, fri)} −0.5`);
  await expect(dialog.getByRole('button', {name: /^(Save assignment|שמירת השיבוץ)$/})).toBeDisabled();
  await dialog.getByRole('radio', {name: he ? 'שני ימים' : 'Two days', exact: true}).click();
  await expect(dialog.getByRole('combobox', {name: he ? 'מהנדס ראשי ביום שבת' : 'Saturday primary engineer', exact: true})).toHaveText(name(backend, other));
  await save(page);
  expect(draftRows(backend, ['2026-11-06', '2026-11-07']).map(r => [r.day, r.end_day, r.primary_id])).toEqual([['2026-11-06', '2026-11-07', fri], ['2026-11-07', '2026-11-08', other]]);
  for (const day of ['2026-11-06', '2026-11-07']) await expect(duty(page, day)).not.toHaveClass(/combined-weekend/);
  await expect(duty(page, '2026-11-07')).not.toHaveClass(/streak-(middle|end)/);
});

test('a split half opens as a regular day with Join; different people choose who keeps it and the kept lock carries over', async ({page, backend, openApp}) => {
  split(backend, ids.a, ids.b, {sat: true});
  await openApp();
  await expect(duty(page, '2026-11-13')).not.toHaveClass(/combined-weekend/);
  await edit(page, '2026-11-14');
  const dialog = page.getByRole('dialog', {name: 'Edit duty', exact: true});
  await expect(dialog.locator('.split-row')).toContainText('Part of a split weekend');
  await expect(dialog.getByRole('radiogroup')).toHaveCount(0);
  await expect(dialog.getByRole('combobox', {name: 'Primary engineer', exact: true})).toHaveText(name(backend, ids.b));
  await dialog.getByRole('button', {name: 'Join', exact: true}).click();
  await expect(dialog).toHaveCount(0);
  const weekend = page.getByRole('dialog', {name: 'Weekend', exact: true});
  await expect(weekend.getByRole('radio', {name: 'One weekend', exact: true})).toHaveAttribute('aria-checked', 'true');
  await expect(weekend.getByRole('button', {name: `Keep ${name(backend, ids.a)}`})).toContainText(`${name(backend, ids.b)} −0.5`);
  await weekend.getByRole('button', {name: `Keep ${name(backend, ids.b)}`}).click();
  await expect(weekend.getByRole('combobox', {name: 'Primary engineer', exact: true})).toHaveText(name(backend, ids.b));
  await expect(weekend.getByRole('button', {name: 'Unlock duty', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await save(page);
  expect(draftRows(backend, ['2026-11-13', '2026-11-14']).map(r => [r.day, r.end_day, r.primary_id, r.locked])).toEqual([['2026-11-13', '2026-11-15', ids.b, true]]);
  await expect(duty(page, '2026-11-13')).toHaveClass(/combined-weekend/);
});

test('halves saved with the same person, lock and cover join into one weekend', async ({page, backend, openApp}) => {
  split(backend, ids.a, ids.b);
  await openApp();
  await edit(page, '2026-11-13');
  await pick(page, 'Primary engineer', name(backend, ids.b));
  await save(page);
  expect(draftRows(backend, ['2026-11-13', '2026-11-14']).map(r => [r.day, r.end_day, r.primary_id])).toEqual([['2026-11-13', '2026-11-15', ids.b]]);
  await expect(duty(page, '2026-11-13')).toHaveClass(/combined-weekend/);
});

async function openPlan(page: Page, he: boolean) {
  await page.getByRole('tab', {name: he ? 'לוח' : 'Schedule', exact: true}).click();
  const label = he ? 'תכנון החודש' : 'Plan the month', primary = page.locator('.month-primary');
  await expect(primary).toBeVisible();
  if (await primary.getAttribute('aria-label') === label) await primary.click(); else await monthAction(page, label);
  await expect(page.locator('.allocation-dialog .plan-rows')).toBeVisible();
}

for (const lang of ['en', 'he'] as const) test(`Plan the month says unlocked split weekends go back to one weekend; Show points at them ${lang}`, async ({page, backend, openApp}) => {
  const he = lang === 'he';
  split(backend, ids.a, ids.b);
  await openApp();
  if (he) await switchLanguage(page, 'he');
  await openPlan(page, he);
  const note = page.locator('[data-split-note]');
  await expect(note).toHaveText(he ? 'סוף שבוע מפוצל אחד יחזור להיות סוף שבוע אחד · אפשר לנעול אותו כדי לשמורהצגה' : '1 split weekend will go back to one weekend · Lock it to keep itShow');
  await note.getByRole('button', {name: he ? 'הצגה' : 'Show', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  for (const day of ['2026-11-13', '2026-11-14']) await expect(duty(page, day)).toHaveClass(/flash-day/);
  // A locked half keeps the split, so the notice goes away.
  await edit(page, '2026-11-13');
  await page.locator('.duty-dialog').getByRole('button', {name: he ? 'נעילת תורנות' : 'Lock duty', exact: true}).click();
  await save(page);
  await openPlan(page, he);
  await expect(note).toHaveCount(0);
});
