import {test, expect, duty, MONTH, switchLanguage, monthAction} from './fixtures';
import type {Page} from '@playwright/test';
import {addDays, dayOf} from '../../lib/rota/engine';

const owner = (day: string) => (dayOf(day) === 6 ? addDays(day, -1) : day).slice(0, 7);
const LOCKED = ['2026-11-02', '2026-11-20'];

// In the ⋯ Month actions menu (decision 2026-11-06), on phones and desktop alike.
const schedule = (page: Page, name = 'Schedule') => page.getByRole('tab', {name, exact: true}).click();
const clearBoard = (page: Page, name = 'Clear board') => monthAction(page, name);
/** Opens the menu and returns the Clear board item; `close` dismisses the menu again. */
async function clearItem(page: Page, name = 'Clear board') {
  await page.getByRole('button', {name: /^(Month actions|פעולות לחודש)$/}).click();
  await expect(page.getByRole('menu')).toBeVisible();
  return page.getByRole('menuitem', {name, exact: true});
}
const close = async (page: Page) => {await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0);};

test('Clear board confirms first, keeps locks, holidays, constraints and history, and Undo restores the draft', async ({page, backend, openApp}) => {
  // A locked weekday and the locked holiday weekend; 12 November is an unlocked holiday.
  for (const r of backend.raw.assignments) if (!r.publication_id && LOCKED.includes(r.day)) r.locked = true;
  await openApp(); await schedule(page);
  const draftRows = () => backend.raw.assignments.filter(r => !r.publication_id);
  const before = structuredClone(backend.raw), saves = () => backend.calls.filter(c => c.name === 'duty_save_schedule');
  const count = draftRows().filter(r => owner(r.day) === MONTH && !r.locked).length;
  const dialog = page.getByRole('alertdialog');

  await clearBoard(page);
  await expect(dialog).toHaveAccessibleName(`Clear ${count} unlocked duties?`);
  await expect(dialog.getByRole('button', {name: 'Cancel', exact: true})).toBeFocused();
  await dialog.getByRole('button', {name: 'Cancel', exact: true}).click();
  await expect(dialog).toBeHidden();
  await clearBoard(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(saves()).toHaveLength(0);
  expect(backend.raw).toEqual(before);

  await clearBoard(page);
  await dialog.getByRole('button', {name: 'Clear board', exact: true}).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(`Cleared ${count} duties.`, {exact: true})).toBeVisible();
  expect(saves()).toHaveLength(1);
  for (const r of draftRows().filter(r => owner(r.day) === MONTH)) {
    const was = before.assignments.find(b => !b.publication_id && b.day === r.day)!;
    // Every duty row stays with its holiday title and extra points; only unlocked people go.
    expect(r).toMatchObject({title: was.title, extra_points: was.extra_points, end_day: was.end_day});
    if (LOCKED.includes(r.day)) expect(r).toMatchObject({primary_id: was.primary_id, secondary_id: was.secondary_id, locked: true});
    else expect(r).toMatchObject({primary_id: null, secondary_id: null, locked: false});
  }
  expect(backend.raw.assignments.filter(r => r.publication_id)).toEqual(before.assignments.filter(r => r.publication_id));
  expect([backend.raw.publications, backend.raw.constraints]).toEqual([before.publications, before.constraints]);
  expect(backend.raw.months[0]).toMatchObject({status: 'draft', generated: false, current_publication_id: before.months[0].current_publication_id});
  await expect(duty(page, '2026-11-02').getByRole('img', {name: 'Locked duty'})).toBeVisible();
  await expect(duty(page, '2026-11-12')).toContainText('Holiday coverage');
  // Nothing left to clear: the action stays visible but disabled.
  const item = await clearItem(page);
  await expect(item).toHaveAttribute('aria-disabled', 'true');
  await expect(item).toHaveAttribute('title', 'Nothing to clear');
  await close(page);

  await page.getByRole('button', {name: 'Undo', exact: true}).click();
  await expect(page.getByText('Duties restored.', {exact: true})).toBeVisible();
  expect(saves()).toHaveLength(2);
  for (const r of draftRows()) {
    const was = before.assignments.find(b => !b.publication_id && b.day === r.day)!;
    expect(r).toMatchObject({primary_id: was.primary_id, secondary_id: was.secondary_id, locked: !!was.locked});
  }
  expect(backend.raw.months[0].generated).toBe(true);
});

test('Clear board is in Hebrew RTL and offers nothing on the published version or a published month', async ({page, backend, openApp}) => {
  await openApp();
  await switchLanguage(page, 'he'); await schedule(page, 'לוח');
  const count = backend.raw.assignments.filter(r => !r.publication_id && owner(r.day) === MONTH).length;
  // Beside Special block in the same menu.
  await expect(await clearItem(page, 'ניקוי הלוח')).toBeVisible();
  await expect(page.getByRole('menuitem', {name: 'מקטע מיוחד', exact: true})).toBeVisible();
  await page.getByRole('menuitem', {name: 'ניקוי הלוח', exact: true}).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toHaveAttribute('dir', 'rtl');
  await expect(dialog).toHaveAccessibleName(`לנקות ${count} תורנויות שאינן נעולות?`);
  await dialog.getByRole('button', {name: 'ניקוי הלוח', exact: true}).click();
  await expect(page.getByText(`${count} תורנויות נוקו.`, {exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'שחזור', exact: true})).toBeVisible();

  const expectNoClear = async () => {await expect(await clearItem(page, 'ניקוי הלוח')).toHaveCount(0); await close(page);};
  // The published version of a reopened draft is read-only here.
  await page.getByRole('radio', {name: 'פורסם', exact: true}).click();
  await expectNoClear();

  // Cancel draft restores the published schedule; a published month has no Clear board at all.
  await monthAction(page, 'ביטול טיוטה');
  await page.getByRole('alertdialog').getByRole('button', {name: 'ביטול הטיוטה', exact: true}).click();
  await expect(page.getByRole('button', {name: 'פתיחה לעריכה', exact: true})).toBeVisible();
  await expectNoClear();
  expect(backend.raw.assignments.filter(r => r.publication_id).every(r => r.primary_id)).toBe(true);
});

test('Clear board waits for Generate, and Undo leaves with the month instead of failing', async ({page, backend, openApp}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openApp(); await schedule(page);
  await clearBoard(page);
  await page.getByRole('alertdialog').getByRole('button', {name: 'Clear board', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Undo', exact: true})).toBeVisible();
  // Undo only edits the cleared month, so another month never offers it.
  await page.getByRole('button', {name: 'Next month', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Undo', exact: true})).toHaveCount(0);
  await page.getByRole('button', {name: 'Previous month', exact: true}).click();
  expect(backend.calls.filter(c => c.name === 'duty_save_schedule')).toHaveLength(1);

  // While Generate runs, a clear would race its save: disabled, with the reason.
  await page.getByRole('button', {name: 'Plan the month', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Confirm & generate', exact: true})).toBeEnabled({timeout: 30_000});
  await page.getByRole('button', {name: 'Confirm & generate', exact: true}).click();
  // The open plan is modal, so the menu can't open behind it: the month's busy primary action
  // (the same busy flag that disables Clear board) stands in.
  await expect(page.locator('.month-primary')).toHaveAttribute('aria-label', 'Generating…');
  await expect(page.locator('.month-primary')).toBeDisabled();
  await page.getByRole('dialog').getByRole('button', {name: 'Cancel', exact: true}).click();
  await page.getByRole('dialog').getByRole('button', {name: 'Close', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  const item = await clearItem(page);
  await expect(item).toHaveAttribute('aria-disabled', 'true');
  await expect(item).toHaveAttribute('title', 'Nothing to clear');
  await close(page);
  expect(errors).toEqual([]);
});

for (const scheme of ['light', 'dark'] as const)
test(`Clear board confirm rests full red, hover only deepens it, disabled stays distinct, ${scheme} system theme`, async ({page, openApp}, info) => {
  test.skip(info.project.name !== 'desktop', 'Pointer hover');
  await page.emulateMedia({colorScheme: scheme});
  await openApp(); await schedule(page);
  await clearBoard(page);
  const confirm = page.getByRole('alertdialog').getByRole('button', {name: 'Clear board', exact: true});
  const look = () => confirm.evaluate(x => [getComputedStyle(x).backgroundColor, getComputedStyle(x).opacity]);
  // --danger at rest (#c0291f light, #ff6b5e dark; the light shade passes 4.5:1 on white): full opacity, never a shade that reads as disabled.
  const rest = scheme === 'light' ? 'rgb(192, 41, 31)' : 'rgb(255, 107, 94)';
  await expect.poll(look).toEqual([rest, '1']);
  await confirm.hover();
  await expect.poll(async () => {const [colour, opacity] = await look(); return colour !== rest && opacity === '1';}, 'hover deepens the red').toBe(true);
  // While saving it is disabled: the shared reduced opacity, without the hover shade.
  let release!: () => void;
  const pending = new Promise<void>(resolve => {release = resolve;});
  await page.route('**/rest/v1/rpc/duty_save_schedule', async route => {await pending; await route.fallback();});
  await confirm.click();
  await expect(confirm).toBeDisabled();
  await expect.poll(async () => {const [colour, opacity] = await look(); return colour === rest && Number(opacity) < 1;}, 'disabled keeps the red, faded').toBe(true);
  release();
  await expect(page.getByRole('alertdialog')).toBeHidden();
});
