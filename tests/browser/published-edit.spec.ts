import {test, expect, ids, duty} from './fixtures';

const net = (page: import('@playwright/test').Page, id: string) => page.locator(`[data-gesture-key="${id}"] .net-points button`);
const call = (backend: import('./fixtures').Backend) => backend.calls.filter(c => c.name === 'duty_edit_published_duty');

test.beforeEach(({backend}) => {backend.raw.months[0].status = 'published';});

test('admin edits a published duty: Temporary by default, copyable summary, new version and Team debt', async ({page, context, openApp, backend}, info) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openApp();
  await duty(page, '2026-11-03').click();
  const dialog = page.getByRole('dialog', {name: 'Edit duty'});
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', {name: 'Review change'})).toBeDisabled();
  await dialog.getByRole('combobox', {name: 'Engineer', exact: true}).click();
  await page.getByRole('option', {name: 'Casey Cedar', exact: true}).click();
  await expect(dialog.getByRole('button', {name: 'Temporary', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog).toContainText('Blair Birch owes Casey Cedar 1 point, repaid in later months.');
  await dialog.getByLabel('Extra points').fill('0.25');
  await expect(dialog.getByRole('alert')).toContainText('steps of 0.5');
  await dialog.getByLabel('Extra points').fill('0.5');
  await dialog.getByRole('button', {name: 'Review change'}).click();
  const review = page.getByRole('dialog', {name: 'Review and copy'});
  const summary = 'Duty change (published schedule)\nDate: Tue 03/11/2026\nEngineer: Blair Birch → Casey Cedar\nPoints: 1 point → 1.5 points\nExtra: none → 0.5 points\nType: Temporary\nBalance: Blair Birch owes Casey Cedar 1 point';
  await expect(review.getByLabel('Summary')).toHaveValue(summary);
  await review.getByRole('button', {name: 'Copy summary'}).click();
  await expect(page.getByText('Summary copied.')).toBeVisible();
  // The async clipboard needs a secure origin (CI serves 127.0.0.1); elsewhere the fallback copies the selection.
  if (await page.evaluate(() => isSecureContext)) expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toBe(summary);
  await info.attach(`published-edit-review-${info.project.name}`, {body: await page.screenshot(), contentType: 'image/png'});
  await review.getByRole('button', {name: 'Publish change'}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByText('Published version 2.')).toBeVisible();
  expect(call(backend)).toHaveLength(1);
  expect(call(backend)[0].params).toMatchObject({p_day: '2026-11-03', p_primary: ids.c, p_extra_points: .5, p_saturday_extra_points: 0, p_kind: 'temporary', p_override_reason: '', p_publication: '20000000-0000-4000-8000-000000000010'});
  await expect(duty(page, '2026-11-03')).toHaveAccessibleName(/Casey Cedar/);
  expect(backend.raw.publications.map(p => p.version)).toEqual([1, 2]);
  // The previous version stays as published history.
  expect(backend.raw.assignments.find(d => d.day === '2026-11-03' && d.publication_id === '20000000-0000-4000-8000-000000000010')!.primary_id).toBe(ids.b);
  await page.getByRole('tab').nth(2).click();
  await expect(net(page, ids.b)).toHaveText('−1net');
  await expect(net(page, ids.c)).toHaveText('+1net');
  await net(page, ids.c).focus();
  await expect(page.locator('.net-breakdown')).toContainText('Published change · November 2026');
});

test('Hebrew: an unavailable engineer needs an override reason; Permanent records no debt', async ({page, openApp, backend}) => {
  await openApp();
  await page.getByRole('button', {name: 'Switch to Hebrew'}).click();
  const owner = backend.raw.assignments.find(d => d.day === '2026-11-04' && d.publication_id)!.primary_id;
  await duty(page, '2026-11-04').click();
  const dialog = page.getByRole('dialog', {name: 'עריכת תורנות'});
  await expect(dialog).toHaveAttribute('dir', 'rtl');
  await dialog.getByRole('combobox', {name: 'מהנדס', exact: true}).click();
  await page.getByRole('option', {name: 'Alex Atlas · לא זמין', exact: true}).click();
  await expect(dialog.getByRole('alert')).toContainText('Alex Atlas לא זמין/ה ב־');
  await expect(dialog.getByRole('alert')).toContainText('Synthetic vacation');
  await dialog.getByRole('button', {name: 'קבוע', exact: true}).click();
  await expect(dialog.getByRole('button', {name: 'בדיקת השינוי'})).toBeDisabled();
  await dialog.getByRole('checkbox', {name: 'חריגה מאילוץ כמנהל'}).check();
  await expect(dialog.getByRole('button', {name: 'בדיקת השינוי'})).toBeDisabled();
  await dialog.getByLabel('נימוק חובה לתיעוד').fill('Covering a family event');
  await dialog.getByRole('button', {name: 'בדיקת השינוי'}).click();
  const summary = page.getByRole('dialog', {name: 'בדיקה והעתקה'}).getByLabel('סיכום');
  await expect(summary).toHaveAttribute('dir', 'rtl');
  await expect(summary).toHaveValue(/^מהנדס: Alex Atlas במקום .+$/m);
  await expect(summary).toHaveValue(/^סוג: קבוע\nמאזן: ללא חוב\nחריגה מאילוץ: Covering a family event$/m);
  // Availability notes are private: never part of the copied record.
  await expect(summary).not.toHaveValue(/Synthetic vacation/);
  await page.getByRole('button', {name: 'חזרה'}).click();
  await expect(page.getByRole('dialog', {name: 'עריכת תורנות'}).getByLabel('נימוק חובה לתיעוד')).toHaveValue('Covering a family event');
  await page.getByRole('button', {name: 'בדיקת השינוי'}).click();
  await page.getByRole('button', {name: 'פרסום השינוי'}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(call(backend)[0].params).toMatchObject({p_day: '2026-11-04', p_primary: ids.a, p_kind: 'permanent', p_override_reason: 'Covering a family event'});
  expect(owner).not.toBe(ids.a);
  expect(backend.balance).toBeNull();
});

test('a combined weekend edits both dates’ extras; engineers keep requesting swaps by tap', async ({page, browser, openApp, backend}) => {
  await openApp();
  await duty(page, '2026-11-06').click();
  const dialog = page.getByRole('dialog', {name: 'Edit duty'});
  await expect(dialog).toContainText('6 Nov – 7 Nov');
  await dialog.getByLabel('Saturday extra points').fill('1');
  await expect(dialog.getByRole('group', {name: 'Compensation'})).toHaveCount(0);
  await dialog.getByRole('button', {name: 'Review change'}).click();
  await expect(page.getByLabel('Summary')).toHaveValue(/Date: Fri 06\/11\/2026 – Sat 07\/11\/2026\n.*\(unchanged\)\nPoints: 1 point → 2 points\nExtra: none → 1 point\nBalance: No debt; the extra counts for /);
  await page.getByRole('button', {name: 'Publish change'}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(call(backend)[0].params).toMatchObject({p_day: '2026-11-06', p_extra_points: 0, p_saturday_extra_points: 1});
  const context = await browser.newContext({viewport: page.viewportSize()!, timezoneId: 'Asia/Jerusalem', locale: 'en-GB', serviceWorkers: 'block'});
  try {
    const engineer = await context.newPage();
    await openApp('a', engineer);
    await duty(engineer, '2026-11-02').click();
    await expect(engineer.getByRole('dialog')).toHaveCount(0);
    await expect(duty(engineer, '2026-11-02')).toHaveAttribute('aria-pressed', 'true');
  } finally {await context.close();}
});

test('a newer version from another tab names the stale editor and blocks Publish until the duty is reopened', async ({page, openApp, backend}) => {
  await openApp();
  await duty(page, '2026-11-03').click();
  const dialog = page.getByRole('dialog', {name: 'Edit duty'});
  await dialog.getByRole('combobox', {name: 'Engineer', exact: true}).click();
  await page.getByRole('option', {name: 'Casey Cedar', exact: true}).click();
  await dialog.getByRole('button', {name: 'Review change'}).click();
  // Another admin publishes a newer version of the month meanwhile.
  const rows = backend.raw.assignments.filter(d => d.publication_id === backend.raw.months[0].current_publication_id).map(d => ({...d}));
  rows.find(d => d.day === '2026-11-03')!.primary_id = ids.a;
  backend.publish('2026-11', rows);
  await page.getByRole('button', {name: 'Publish change'}).click();
  await expect(page.getByText('A newer version of this month was published or a draft was reopened. Close the duty, open it again, then edit it.', {exact: true}).first()).toBeVisible();
  const review = page.getByRole('dialog', {name: 'Review and copy'});
  await expect(review.getByRole('alert')).toContainText('This month changed after you opened this duty');
  await expect(review.getByRole('button', {name: 'Publish change'})).toBeDisabled();
  expect(call(backend)).toHaveLength(1);
  await page.keyboard.press('Escape');
  await duty(page, '2026-11-03').click();
  const fresh = page.getByRole('dialog', {name: 'Edit duty'});
  await expect(fresh.getByRole('alert')).toHaveCount(0);
  await expect(fresh.getByRole('combobox', {name: 'Engineer', exact: true})).toHaveText('Alex Atlas');
});

test('a pending swap that includes the duty is named before the edit', async ({page, openApp, backend}) => {
  const pub = backend.raw.months[0].current_publication_id!;
  const at = (day: string) => backend.raw.assignments.find(d => d.publication_id === pub && d.day === day)!;
  backend.raw.swapRequests = [{id: 'swap-1', month: '2026-11', source_publication_id: pub, requester_id: at('2026-11-03').primary_id!, other_id: at('2026-11-05').primary_id!,
    from_day: '2026-11-03', from_end_day: '2026-11-04', to_day: '2026-11-05', to_end_day: '2026-11-06', explanation: '', status: 'awaiting_admin',
    accepted_by: at('2026-11-05').primary_id!, accepted_at: '2026-11-01T08:00:00Z', created_at: '2026-11-01T07:00:00Z', resolved_at: null, resolved_by: null, result_publication_id: null, override_reason: ''}];
  await openApp();
  await duty(page, '2026-11-05').click();
  await expect(page.getByRole('dialog', {name: 'Edit duty'}).getByRole('note')).toHaveText('A pending swap request includes this duty. Publishing cancels it, or asks the new engineer to accept again.');
});
