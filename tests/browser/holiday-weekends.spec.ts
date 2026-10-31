import {test, expect, duty, ids, type Backend} from './fixtures';
import type {Page} from '@playwright/test';

// Fixture rows exist twice: the published copy and the working draft. The draft calendar is what the admin edits.
const rows = (backend: Backend, day: string) => backend.raw.assignments.filter(r => r.day === day);
const draftRow = (backend: Backend, day: string) => backend.raw.assignments.find(r => r.day === day && r.publication_id === null)!;
function fridayOnlyHoliday(backend: Backend) {
  for (const r of rows(backend, '2026-11-20')) {r.saturday_extra_points = 0; r.points = 3;}
}
function splitHoliday(backend: Backend, locked = false) {
  // The 27–28 November weekend is split by hand with +1 on each date.
  backend.raw.assignments = backend.raw.assignments.filter(r => r.day !== '2026-11-27');
  for (const publication of [backend.raw.publications[0].id, null]) {
    backend.raw.assignments.push(
      {id: `split-fri-${publication ?? 'draft'}`, publication_id: publication, day: '2026-11-27', end_day: '2026-11-28', primary_id: ids.d, secondary_id: null, locked, manager_override: false, title: 'Split', extra_points: 1, saturday_extra_points: 0, points: 1.5},
      {id: `split-sat-${publication ?? 'draft'}`, publication_id: publication, day: '2026-11-28', end_day: '2026-11-29', primary_id: ids.e, secondary_id: null, locked, manager_override: false, title: 'Split', extra_points: 1, saturday_extra_points: 0, points: 1.5});
  }
}
const box = async (locator: ReturnType<Page['locator']>) => (await locator.boundingBox())!;
// The desktop week keeps Sunday on the left in Hebrew; the phone grid flips. Mirroring follows the grid.
const gridIsRtl = (page: Page) => page.locator('.calendar-grid').evaluate(e => getComputedStyle(e).direction === 'rtl');

test('the holiday badge sits on the date line at normal row height and marks only the holiday dates, in English and Hebrew', async ({page, backend, openApp}) => {
  fridayOnlyHoliday(backend);
  await openApp();
  const weekend = duty(page, '2026-11-20'), badge = weekend.locator('.tiny-badge'), dateLine = weekend.locator('.date-line');
  await expect(badge).toHaveText('+2');
  await expect(weekend).toHaveClass(/holiday-friday/);
  await expect(weekend).not.toHaveClass(/holiday-saturday/);
  // Both dates +2: the badge is the weekend's total and both dates are marked.
  await expect(duty(page, '2026-11-12').locator('.tiny-badge')).toHaveText('+2');
  for (const lang of ['en', 'he'] as const) {
    if (lang === 'he') {await page.getByRole('button', {name: 'Switch to Hebrew'}).click(); await expect(page.locator('.app-shell')).toHaveAttribute('dir', 'rtl');}
    const b = await box(badge), line = await box(dateLine), cell = await box(weekend), neighbor = await box(duty(page, '2026-11-19'));
    expect(b.y).toBeGreaterThanOrEqual(line.y - 1); expect(b.y + b.height).toBeLessThanOrEqual(line.y + line.height + 1);
    // At the grid's inline end (right in a left-to-right grid, left in a right-to-left one), like a regular special cell.
    if (await gridIsRtl(page)) expect(b.x).toBeLessThan(cell.x + cell.width * 0.2); else expect(b.x + b.width).toBeGreaterThan(cell.x + cell.width * 0.8);
    const regular = await box(duty(page, '2026-11-12').locator('.tiny-badge')), regularCell = await box(duty(page, '2026-11-12'));
    expect(Math.abs((b.x - cell.x) - (regular.x - regularCell.x)) < 3 || Math.abs((cell.x + cell.width - b.x - b.width) - (regularCell.x + regularCell.width - regular.x - regular.width)) < 3).toBe(true);
    expect(Math.abs(cell.height - neighbor.height)).toBeLessThanOrEqual(1);
  }
});

test('removing the extra points works on a combined weekend and on a hand-split weekend, locked or not', async ({page, backend, openApp}) => {
  splitHoliday(backend, true);
  for (const r of rows(backend, '2026-11-20')) r.locked = true;
  await openApp();
  // Combined holiday weekend (+2 on both dates), locked: one combined duty stays, worth one point.
  await duty(page, '2026-11-20').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', {name: 'Remove extra points from this duty', exact: true}).click();
  await expect(dialog).toBeHidden();
  expect(draftRow(backend, '2026-11-20')).toMatchObject({end_day: '2026-11-22', title: '', extra_points: 0, saturday_extra_points: 0, points: 1, locked: true});
  expect(backend.calls.filter(c => c.name === 'duty_save_schedule').at(-1)!.params.p_state).toMatchObject({lock_edits: ['2026-11-20', '2026-11-21']});
  await expect(duty(page, '2026-11-20').locator('.tiny-badge')).toHaveCount(0);
  await expect(duty(page, '2026-11-20')).not.toHaveClass(/special/);
  // Split weekend: the Saturday half loses only its own extra; Friday keeps +1 and the split stays.
  await duty(page, '2026-11-28').click();
  await expect(dialog.locator('[data-slot="dialog-description"]')).toContainText('27 Nov – 28 Nov');
  await dialog.getByRole('button', {name: 'Remove extra points from this duty', exact: true}).click();
  await expect(dialog).toBeHidden();
  expect(draftRow(backend, '2026-11-28')).toMatchObject({end_day: '2026-11-29', title: '', extra_points: 0, points: 0.5, primary_id: ids.e});
  expect(draftRow(backend, '2026-11-27')).toMatchObject({end_day: '2026-11-28', title: 'Split', extra_points: 1, points: 1.5, primary_id: ids.d});
  await expect(duty(page, '2026-11-27').locator('.tiny-badge')).toHaveText('+1');
  await expect(duty(page, '2026-11-28').locator('.tiny-badge')).toHaveCount(0);
  await expect(duty(page, '2026-11-28')).toBeVisible();
});

test('the special block dialog explains per-date extra points', async ({page, openApp}) => {
  await openApp();
  await page.getByRole('button', {name: 'Special block', exact: true}).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('[data-slot="dialog-description"]')).toHaveText('Each date is a separate duty and adds the extra points; a weekend in the range stays one Friday–Sunday duty.');
  await expect(dialog.locator('.special-summary')).toContainText('2 points per weekday');
  await expect(dialog.locator('.special-summary')).toContainText('Friday / Saturday: ½ + extra each, so a whole holiday weekend is 1 + 2 × extra.');
});

test('adjacent duties of one member render as one bar with one name, one title and one total, continuing across the row break and mirrored in RTL', async ({page, backend, openApp}) => {
  // Wed 4 → Thu 5 → weekend 6–7 → Sun 8 (holiday +1) → Mon 9 (holiday +1), all Blair's; the
  // neighbours on 3 and 10 November belong to someone else so the streak has clear ends.
  for (const day of ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-08', '2026-11-09']) for (const r of rows(backend, day)) r.primary_id = ids.b;
  for (const day of ['2026-11-03', '2026-11-10']) for (const r of rows(backend, day)) r.primary_id = ids.d;
  for (const day of ['2026-11-08', '2026-11-09']) for (const r of rows(backend, day)) {r.title = 'Holiday'; r.extra_points = 1; r.points = 2;}
  await openApp();
  const chip = (day: string) => duty(page, day).locator('.assignment-chip');
  await expect(duty(page, '2026-11-04')).toHaveClass(/streak-start/);
  await expect(chip('2026-11-04')).toHaveText('Blair');
  await expect(duty(page, '2026-11-05')).toHaveClass(/streak-middle/);
  await expect(chip('2026-11-05')).toHaveText('');
  await expect(duty(page, '2026-11-06')).toHaveClass(/streak-middle/);
  await expect(duty(page, '2026-11-06')).toHaveClass(/streak-break-after/);
  await expect(duty(page, '2026-11-08')).toHaveClass(/streak-break-before/);
  await expect(chip('2026-11-08')).toHaveText('Blair');
  await expect(duty(page, '2026-11-08').locator('.special-title')).toHaveText('Holiday');
  await expect(duty(page, '2026-11-08').locator('.tiny-badge')).toHaveCount(0);
  await expect(duty(page, '2026-11-09')).toHaveClass(/streak-end/);
  await expect(duty(page, '2026-11-09').locator('.special-title')).toHaveCount(0);
  await expect(duty(page, '2026-11-09').locator('.tiny-badge')).toHaveText('+2');
  // A lone duty after the streak is untouched.
  await expect(duty(page, '2026-11-10')).toHaveClass(/streak-only/);
  await expect(chip('2026-11-10')).not.toHaveText('');
  for (const lang of ['en', 'he'] as const) {
    if (lang === 'he') {await page.getByRole('button', {name: 'Switch to Hebrew'}).click(); await expect(page.locator('.app-shell')).toHaveAttribute('dir', 'rtl');}
    const a = await box(chip('2026-11-04')), b = await box(chip('2026-11-05')), weekend = await box(chip('2026-11-06')), sunday = await box(chip('2026-11-08'));
    // Joined inside a row: the bar runs on with no gap; the row break keeps each chip inside its own cell.
    if (await gridIsRtl(page)) expect(Math.abs(b.x + b.width - a.x)).toBeLessThanOrEqual(1); else expect(Math.abs(a.x + a.width - b.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(1);
    expect(sunday.y).toBeGreaterThan(weekend.y + weekend.height);
    const weekendCell = await box(duty(page, '2026-11-06'));
    expect(weekend.x).toBeGreaterThanOrEqual(weekendCell.x - 1); expect(weekend.x + weekend.width).toBeLessThanOrEqual(weekendCell.x + weekendCell.width + 1);
  }
  // Tapping a date inside the bar still edits that date's duty.
  await duty(page, '2026-11-05').click();
  await expect(page.getByRole('dialog').locator('[data-slot="dialog-description"]')).toContainText('5 בנוב׳');
  await expect(page.getByRole('dialog').getByRole('combobox', {name: 'מהנדס ראשי', exact: true})).toBeVisible();
});
