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

// Thu 5 → weekend 6–7 → Sun 8 → Mon 9, all Blair's, with someone else on 4 and 10 November: a streak across the row break.
function crossingStreak(backend: Backend) {
  for (const day of ['2026-11-05', '2026-11-06', '2026-11-08', '2026-11-09']) for (const r of rows(backend, day)) r.primary_id = ids.b;
  for (const day of ['2026-11-04', '2026-11-10']) for (const r of rows(backend, day)) r.primary_id = ids.d;
}
const centre = (b: {x: number; width: number}) => b.x + b.width / 2;

test('each row of a streak is one level bar with no join, its name centred once across the row', async ({page, backend, openApp}) => {
  crossingStreak(backend);
  await openApp();
  const chip = (day: string) => duty(page, day).locator('.assignment-chip'), label = (day: string) => duty(page, day).locator('.streak-label');
  await expect(label('2026-11-05')).toHaveText('Blair');
  await expect(label('2026-11-08')).toHaveText('Blair');
  for (const day of ['2026-11-06', '2026-11-09']) await expect(chip(day)).toHaveText('');
  for (const lang of ['en', 'he'] as const) {
    if (lang === 'he') {await page.getByRole('button', {name: 'Switch to Hebrew'}).click(); await expect(page.locator('.app-shell')).toHaveAttribute('dir', 'rtl');}
    const rtl = await gridIsRtl(page);
    const thu = await box(chip('2026-11-05')), weekend = await box(chip('2026-11-06')), sun = await box(chip('2026-11-08')), mon = await box(chip('2026-11-09'));
    // Same top and height in every cell of a row segment, and as tall as a lone duty's bar; the joins meet edge to edge.
    for (const [a, b] of [[thu, weekend], [sun, mon]]) {
      expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(a.height - b.height)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(rtl ? b.x + b.width - a.x : a.x + a.width - b.x)).toBeLessThanOrEqual(0.5);
    }
    expect(Math.abs(thu.height - (await box(chip('2026-11-04'))).height)).toBeLessThanOrEqual(0.5);
    // Thu–Fri–Sat: one name at the bar's centre, which is the Friday column; Sun–Mon: one name at their boundary.
    const first = await box(label('2026-11-05')), second = await box(label('2026-11-08')), friday = await box(duty(page, '2026-11-06')), sunday = await box(duty(page, '2026-11-08'));
    expect(Math.abs(centre(first) - (Math.min(thu.x, weekend.x) + Math.max(thu.x + thu.width, weekend.x + weekend.width)) / 2)).toBeLessThanOrEqual(1.5);
    if (rtl) expect(centre(first)).toBeGreaterThan(friday.x + friday.width / 2); else expect(centre(first)).toBeLessThan(friday.x + friday.width / 2);
    expect(Math.abs(centre(second) - (rtl ? sunday.x : sunday.x + sunday.width))).toBeLessThanOrEqual(1.5);
    for (const name of [first, second]) {expect(name.y).toBeGreaterThanOrEqual(thu.y - 1); expect(name.height).toBeLessThanOrEqual(thu.height + 1);}
    // The arrow and the notch point along the grid's own direction (desktop Hebrew keeps a left-to-right week).
    const clip = (day: string) => chip(day).evaluate(e => getComputedStyle(e, '::before').clipPath);
    expect(await clip('2026-11-06')).toContain(rtl ? '0px 50%' : '100% 50%');
    expect(await clip('2026-11-08')).toContain(rtl ? 'calc(100% - 7px) 50%' : '7px 50%');
  }
  // The centred name lets taps through: tapping it over the Friday column edits the weekend, not Thursday.
  const name = await box(label('2026-11-05'));
  await page.mouse.click(centre(name), name.y + name.height / 2);
  await expect(page.getByRole('dialog').locator('[data-slot="dialog-description"]')).toContainText('6 בנוב׳');
});

test('the lock, the dates and the +extra never overlap on a locked holiday weekend, weekday or split weekend', async ({page, backend, openApp}, info) => {
  splitHoliday(backend, true);
  for (const day of ['2026-11-12', '2026-11-20']) for (const r of rows(backend, day)) r.locked = true;
  await openApp();
  const overlap = (a: {x: number; y: number; width: number; height: number}, b: typeof a) =>
    a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
  for (const lang of ['en', 'he'] as const) {
    if (lang === 'he') await page.getByRole('button', {name: 'Switch to Hebrew'}).click();
    for (const width of info.project.name === 'mobile' ? [320, 375, 390] : [1440, 1024, 700]) {
      await page.setViewportSize({width, height: 900});
      for (const day of ['2026-11-12', '2026-11-20', '2026-11-27', '2026-11-28']) {
        const cell = duty(page, day), lock = cell.locator('.duty-lock-indicator'), badge = cell.locator('.tiny-badge');
        await expect(lock).toBeVisible(); await expect(badge).toBeVisible();
        const c = await box(cell), parts = await Promise.all([...await cell.locator('.day-number > span').all(), lock, badge].map(box));
        for (const [i, a] of parts.entries()) {
          expect(a.x, `${day} at ${width}px stays in its cell`).toBeGreaterThanOrEqual(c.x - 0.5);
          expect(a.x + a.width).toBeLessThanOrEqual(c.x + c.width + 0.5);
          for (const b of parts.slice(i + 1)) expect(overlap(a, b), `${day} at ${width}px in ${lang}`).toBe(false);
        }
        // The marks stay above the bar.
        const bar = await box(cell.locator('.assignment-chip'));
        for (const mark of parts) expect(mark.y + mark.height).toBeLessThanOrEqual(bar.y + 0.5);
      }
      // Every bar of a week with marks starts at the same height.
      for (const week of [['2026-11-08', '2026-11-11', '2026-11-12', '2026-11-13'], ['2026-11-15', '2026-11-19', '2026-11-20'], ['2026-11-22', '2026-11-26', '2026-11-27', '2026-11-28']]) {
        const tops = await Promise.all(week.map(day => box(duty(page, day).locator('.assignment-chip')).then(b => b.y)));
        expect(Math.max(...tops) - Math.min(...tops), `${week[0]} week at ${width}px`).toBeLessThanOrEqual(0.5);
      }
    }
  }
});

test('weekend bars centre the name: plain, locked holiday, a weekend ending a streak row and each half of a split weekend', async ({page, backend, openApp}, info) => {
  splitHoliday(backend, true);
  // Fri–Sat 6–7 → Sun 8 is one member's streak; the weekend ends its row alone, so it keeps its own name.
  for (const day of ['2026-11-06', '2026-11-08']) for (const r of rows(backend, day)) r.primary_id = ids.b;
  for (const day of ['2026-11-05', '2026-11-09']) for (const r of rows(backend, day)) r.primary_id = ids.d;
  for (const r of rows(backend, '2026-11-20')) r.locked = true;
  // Someone else on Thursday 26, so the split Friday stands alone.
  for (const r of rows(backend, '2026-11-26')) r.primary_id = ids.a;
  await openApp();
  for (const lang of ['en', 'he'] as const) {
    if (lang === 'he') await page.getByRole('button', {name: 'Switch to Hebrew'}).click();
    for (const width of info.project.name === 'mobile' ? [320, 375, 390] : [1440, 1024, 700]) {
      await page.setViewportSize({width, height: 900});
      for (const day of ['2026-11-06', '2026-11-13', '2026-11-20', '2026-11-27', '2026-11-28']) {
        const chip = duty(page, day).locator('.assignment-chip'), name = chip.locator('> span:last-child');
        await expect(name).not.toHaveText('');
        const bar = await box(chip), text = await box(name);
        expect(Math.abs(centre(text) - centre(bar)), `${day} at ${width}px in ${lang}`).toBeLessThanOrEqual(1.5);
        expect(text.x).toBeGreaterThanOrEqual(bar.x - 0.5); expect(text.x + text.width).toBeLessThanOrEqual(bar.x + bar.width + 0.5);
      }
    }
  }
});
