import {test, expect, duty, MONTH} from './fixtures';
import type {Page} from '@playwright/test';
import {addDays, dayOf} from '../../lib/rota/engine';

const owner = (day: string) => (dayOf(day) === 6 ? addDays(day, -1) : day).slice(0, 7);
const LOCKED = ['2026-11-02', '2026-11-20'];

// Beside Special block above the calendar, on phones and desktop alike.
const clearButton = (page: Page, name = 'Clear board') => page.locator('.calendar-top').getByRole('button', {name, exact: true});

test('Clear board confirms first, keeps locks, holidays, constraints and history, and Undo restores the draft', async ({page, backend, openApp}) => {
  // A locked weekday and the locked holiday weekend; 12 November is an unlocked holiday.
  for (const r of backend.raw.assignments) if (!r.publication_id && LOCKED.includes(r.day)) r.locked = true;
  await openApp();
  const draftRows = () => backend.raw.assignments.filter(r => !r.publication_id);
  const before = structuredClone(backend.raw), saves = () => backend.calls.filter(c => c.name === 'duty_save_schedule');
  const count = draftRows().filter(r => owner(r.day) === MONTH && !r.locked).length;
  const dialog = page.getByRole('dialog');

  await clearButton(page).click();
  await expect(dialog).toHaveAccessibleName(`Clear ${count} unlocked duties?`);
  await expect(dialog.getByRole('button', {name: 'Cancel', exact: true})).toBeFocused();
  await dialog.getByRole('button', {name: 'Cancel', exact: true}).click();
  await expect(dialog).toBeHidden();
  await clearButton(page).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(saves()).toHaveLength(0);
  expect(backend.raw).toEqual(before);

  await clearButton(page).click();
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
  await expect(clearButton(page)).toBeDisabled();
  await expect(clearButton(page)).toHaveAttribute('title', 'No unlocked duties to clear.');

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
  await page.getByRole('button', {name: 'Switch to Hebrew', exact: true}).click();
  const count = backend.raw.assignments.filter(r => !r.publication_id && owner(r.day) === MONTH).length;
  const special = page.locator('.calendar-top').getByRole('button', {name: 'מקטע מיוחד', exact: true});
  // Right next to Special block on the same row, the same size, on phones too (the pair wraps together).
  const [clearBox, specialBox] = [await clearButton(page, 'ניקוי הלוח').boundingBox(), await special.boundingBox()];
  expect(Math.abs(clearBox!.y - specialBox!.y)).toBeLessThan(1);
  expect(clearBox!.height).toBe(specialBox!.height);
  expect(Math.min(Math.abs(clearBox!.x + clearBox!.width - specialBox!.x), Math.abs(specialBox!.x + specialBox!.width - clearBox!.x))).toBeLessThan(10);
  await clearButton(page, 'ניקוי הלוח').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAttribute('dir', 'rtl');
  await expect(dialog).toHaveAccessibleName(`לנקות ${count} תורנויות שאינן נעולות?`);
  await dialog.getByRole('button', {name: 'ניקוי הלוח', exact: true}).click();
  await expect(page.getByText(`${count} תורנויות נוקו.`, {exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'שחזור', exact: true})).toBeVisible();

  const expectNoClear = () => expect(clearButton(page, 'ניקוי הלוח')).toHaveCount(0);
  // The published version of a reopened draft is read-only here.
  await page.getByRole('button', {name: 'פורסם', exact: true}).click();
  await expectNoClear();

  // Cancel draft restores the published schedule; a published month has no Clear board at all.
  await page.getByRole('button', {name: 'ביטול טיוטה', exact: true}).click();
  await page.getByRole('button', {name: 'ביטול הטיוטה', exact: true}).click();
  await expect(page.getByRole('button', {name: 'פתיחת טיוטה', exact: true})).toBeVisible();
  await expectNoClear();
  expect(backend.raw.assignments.filter(r => r.publication_id).every(r => r.primary_id)).toBe(true);
});

test('Clear board waits for Generate, and Undo leaves with the month instead of failing', async ({page, backend, openApp}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openApp();
  await clearButton(page).click();
  await page.getByRole('dialog').getByRole('button', {name: 'Clear board', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Undo', exact: true})).toBeVisible();
  // Undo only edits the cleared month, so another month never offers it.
  await page.getByRole('button', {name: 'Next month', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Undo', exact: true})).toHaveCount(0);
  await page.getByRole('button', {name: 'Previous month', exact: true}).click();
  expect(backend.calls.filter(c => c.name === 'duty_save_schedule')).toHaveLength(1);

  // While Generate runs, a clear would race its save: disabled, with the reason.
  await page.getByRole('button', {name: 'Generate month', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Confirm & generate', exact: true})).toBeEnabled({timeout: 30_000});
  await page.getByRole('button', {name: 'Confirm & generate', exact: true}).click();
  // The open plan hides the calendar from the accessibility tree, so match the button itself.
  const behindPlan = page.locator('.calendar-draft-tools button', {hasText: 'Clear board'});
  await expect(behindPlan).toBeDisabled({timeout: 30_000});
  await expect(behindPlan).toHaveAttribute('title', 'Wait for Generate to finish.');
  await page.getByRole('dialog').getByRole('button', {name: 'Cancel', exact: true}).click();
  await page.getByRole('dialog').getByRole('button', {name: 'Close', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(clearButton(page)).toBeDisabled();
  await expect(clearButton(page)).toHaveAttribute('title', 'No unlocked duties to clear.');
  expect(errors).toEqual([]);
});

test('Clear board and Special block share one row on iPhones, as icons when the labels cannot fit', async ({page, openApp}, info) => {
  test.skip(info.project.name !== 'mobile', 'Phone widths');
  await openApp();
  const tools = page.locator('.calendar-draft-tools'), buttons = tools.locator('button');
  const row = async () => {
    const [a, b] = await buttons.evaluateAll(list => list.map(x => x.getBoundingClientRect().toJSON()));
    expect(Math.abs(a.y - b.y)).toBeLessThan(1);
    return [a, b];
  };
  for (const lang of ['en', 'he'] as const) {
    const [clear, special] = lang === 'en' ? ['Clear board', 'Special block'] : ['ניקוי הלוח', 'מקטע מיוחד'];
    if (lang === 'he') await page.getByRole('button', {name: 'Switch to Hebrew', exact: true}).click();
    for (const width of [375, 390]) {
      await page.setViewportSize({width, height: 844});
      await expect(tools).not.toHaveAttribute('data-compact');
      await expect(buttons.nth(0)).toHaveText(clear);
      await row();
    }
    // Narrower than both labels on any platform's fonts (Safari text zoom does the same): icons, still one row.
    await page.setViewportSize({width: 180, height: 844});
    await expect(tools).toHaveAttribute('data-compact', '');
    for (const [i, name] of [clear, special].entries()) {
      await expect(buttons.nth(i)).toHaveAccessibleName(name);
      await expect(buttons.nth(i)).toHaveAttribute('title', name);
    }
    for (const box of await row()) expect([Math.round(box.width), Math.round(box.height)]).toEqual([44, 44]);
    await page.setViewportSize({width: 390, height: 844});
    await expect(tools).not.toHaveAttribute('data-compact');
  }
});
