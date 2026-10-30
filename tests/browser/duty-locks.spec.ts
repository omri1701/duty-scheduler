import {test, expect, duty, ids, MONTH} from './fixtures';

test('lock edits save atomically with a new primary; dismissals discard both lock and unlock', async ({page, backend, openApp}) => {
  backend.raw.assignments.find(d => d.day === '2026-11-02' && !d.publication_id)!.manager_override = true;
  await openApp();
  const cell = duty(page, '2026-11-02'), dialog = page.getByRole('dialog', {name: 'Edit duty', exact: true});
  const before = structuredClone(backend.raw.assignments);
  for (const dismissal of ['close', 'escape', 'outside']) {
    await cell.click();
    await dialog.getByRole('button', {name: 'Lock duty', exact: true}).click();
    await expect(dialog.getByRole('button', {name: 'Unlock duty', exact: true})).toHaveAttribute('aria-pressed', 'true');
    if (dismissal === 'close') await dialog.getByRole('button', {name: 'Close', exact: true}).click();
    else if (dismissal === 'escape') await page.keyboard.press('Escape');
    else await page.mouse.click(5, 5);
    await expect(dialog).toBeHidden();
    expect(backend.raw.assignments).toEqual(before);
    await expect(cell.getByRole('img', {name: 'Locked duty'})).toHaveCount(0);
  }
  expect(backend.calls.filter(c => c.name === 'duty_save_schedule')).toHaveLength(0);
  await cell.click();
  await dialog.getByRole('combobox', {name: 'Primary engineer', exact: true}).click();
  await page.getByRole('option', {name: 'Drew Dale', exact: true}).click();
  await dialog.getByRole('button', {name: 'Lock duty', exact: true}).click();
  await dialog.getByRole('button', {name: 'Save assignment', exact: true}).click();
  await expect(dialog).toBeHidden();
  await expect(cell.getByRole('img', {name: 'Locked duty'})).toBeVisible();
  expect(backend.raw.assignments.find(d => d.day === '2026-11-02' && !d.publication_id)).toMatchObject({primary_id: ids.d, locked: true, manager_override: false});
  const save = backend.calls.find(c => c.name === 'duty_save_schedule')!;
  expect(save.params.p_state).toMatchObject({lock_edits: ['2026-11-02']});
  expect(backend.raw.assignments.filter(d => d.day !== '2026-11-02' || d.publication_id)).toEqual(before.filter(d => d.day !== '2026-11-02' || d.publication_id).map(d => d.publication_id ? d : {...d, locked: false}));
  await page.reload();
  await expect(cell.getByRole('img', {name: 'Locked duty'})).toBeVisible();
  await cell.click();
  await dialog.getByRole('button', {name: 'Unlock duty', exact: true}).click();
  await page.keyboard.press('Escape');
  await cell.click();
  await expect(dialog.getByRole('button', {name: 'Unlock duty', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', {name: 'Unlock duty', exact: true}).click();
  await dialog.getByRole('button', {name: 'Save assignment', exact: true}).click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(cell.getByRole('img', {name: 'Locked duty'})).toHaveCount(0);
});

test('lock-only save retains the existing override and failed saves keep the local toggle', async ({page, backend, openApp}) => {
  const original = backend.raw.assignments.find(d => d.day === '2026-11-02' && !d.publication_id)!;
  original.manager_override = true;
  backend.raw.assignments.find(d => d.day === original.day && !!d.publication_id)!.locked = true;
  await openApp();
  const cell = duty(page, original.day), dialog = page.getByRole('dialog');
  await cell.click(); await dialog.getByRole('button', {name: 'Lock duty', exact: true}).click();
  backend.failNextSave = true;
  await dialog.getByRole('button', {name: 'Save assignment', exact: true}).click();
  await expect(page.getByText('Synthetic stale revision. Refresh and try again.', {exact: true})).toBeVisible();
  await expect(dialog.getByRole('button', {name: 'Unlock duty', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await expect(cell.getByRole('img', {name: 'Locked duty'})).toHaveCount(0);
  expect(backend.raw.assignments.find(d => d.id === original.id)?.locked).toBe(false);
  await dialog.getByRole('button', {name: 'Save assignment', exact: true}).click();
  await expect(dialog).toBeHidden();
  expect(backend.raw.assignments.find(d => d.id === original.id)).toMatchObject({locked: true, manager_override: true, secondary_id: original.secondary_id});
  await page.getByRole('button', {name: 'Published', exact: true}).click();
  await expect(page.getByRole('img', {name: 'Locked duty'})).toHaveCount(0);
});

test('weekend lock covers both saved primaries and preserves emergency cover in Hebrew RTL', async ({page, backend, openApp}, info) => {
  const before = structuredClone(backend.raw.assignments.find(d => d.day === '2026-11-06' && !d.publication_id)!);
  await openApp();
  await page.getByRole('button', {name: 'Switch to Hebrew'}).click();
  await duty(page, '2026-11-06').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAttribute('dir', 'rtl');
  await dialog.getByRole('button', {name: 'נעילת תורנות', exact: true}).click();
  await dialog.screenshot({path: info.outputPath('weekend-lock-he.png')});
  await dialog.getByRole('button', {name: 'שמירת השיבוץ', exact: true}).click();
  await expect(dialog).toBeHidden();
  expect(backend.raw.assignments.find(d => d.day === before.day && !d.publication_id)).toMatchObject({...before, locked: true});
  await expect(duty(page, before.day).getByRole('img', {name: 'תורנות נעולה'})).toBeVisible();
  await duty(page, before.day).click();
  await dialog.getByRole('combobox', {name: 'מהנדס ביום שבת', exact: true}).click();
  await page.getByRole('option', {name: 'Drew Dale', exact: true}).click();
  if (await dialog.getByRole('checkbox').isVisible()) await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', {name: 'שמירת השיבוץ', exact: true}).click();
  await expect(dialog).toBeHidden();
  for (const day of ['2026-11-06', '2026-11-07']) {
    expect(backend.raw.assignments.find(d => d.day === day && !d.publication_id)?.locked).toBe(true);
    await expect(duty(page, day).getByRole('img', {name: 'תורנות נעולה'})).toBeVisible();
  }
});

test('saved locks survive reloads and repeated real generations; unlocking releases the primary', async ({page, backend, openApp}) => {
  test.setTimeout(180_000);
  backend.raw.assignments = [{id: 'manual', publication_id: null, day: '2026-11-02', end_day: '2026-11-03', primary_id: ids.admin, secondary_id: ids.a, title: '', extra_points: 0, points: 1, manager_override: false}];
  backend.raw.publications = [];
  backend.raw.months[0] = {...backend.raw.months[0], current_publication_id: null, status: 'draft', generated: false};
  backend.raw.members.forEach((m, i) => {if (i >= 6) m.active = false;});
  await openApp();
  await duty(page, '2026-11-02').click();
  await page.getByRole('button', {name: 'Lock duty', exact: true}).click();
  await page.getByRole('button', {name: 'Save assignment', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  async function generate() {
    await page.getByRole('button', {name: /^(Generate month|Regenerate)$/}).click();
    await expect(page.getByText('Explicit locks & exceptions', {exact: false})).toHaveCount(0);
    const confirm = page.getByRole('button', {name: 'Confirm & generate', exact: true});
    await expect(confirm).toBeEnabled({timeout: 30_000});
    await confirm.click();
    await expect(page.getByRole('dialog')).toBeHidden({timeout: 50_000});
  }
  for (let i = 0; i < 2; i++) {
    await page.reload(); await generate();
    expect(backend.raw.assignments.find(d => d.day === '2026-11-02')).toMatchObject({primary_id: ids.admin, secondary_id: ids.a, locked: true});
    await expect(duty(page, '2026-11-02').getByRole('img', {name: 'Locked duty'})).toBeVisible();
    expect(backend.allocations.get(MONTH)!.locks).toEqual([{dutyId: '2026-11-02', engineer: ids.admin}]);
  }
  await duty(page, '2026-11-02').click();
  await page.getByRole('button', {name: 'Unlock duty', exact: true}).click();
  await page.getByRole('button', {name: 'Save assignment', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  backend.raw.constraints.push({member_id: ids.admin, day: '2026-11-02', kind: 'no', note: ''});
  backend.raw.revision!++;
  await page.reload(); await generate();
  const reassigned = backend.raw.assignments.find(d => d.day === '2026-11-02')!;
  expect(reassigned.primary_id).not.toBe(ids.admin);
  expect(reassigned.secondary_id).toBe(ids.a);
  expect(backend.allocations.get(MONTH)!.locks).toEqual([]);
  await expect(duty(page, '2026-11-02').getByRole('img', {name: 'Locked duty'})).toHaveCount(0);
});
