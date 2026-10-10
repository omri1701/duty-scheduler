import {test, expect, ids, touchEvent} from './fixtures';

test('profile reopening resets edits and captures the latest saved name', async ({page, openApp, backend}) => {
  await openApp();
  await page.getByRole('button', {name: 'My profile', exact: true}).click();
  const name = page.getByRole('textbox', {name: 'Display name'});
  await expect(name).toHaveValue('Avery Admin');
  await name.fill('Unsaved edit');
  backend.raw.members.find(m => m.id === ids.admin)!.name = 'Updated Admin';
  const loaded = page.waitForResponse('**/rest/v1/rpc/duty_load');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await loaded;
  await expect(page.locator('.admin-avatar')).toHaveText('UA');
  await expect(name).toHaveValue('Unsaved edit');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('button', {name: 'My profile', exact: true}).click();
  await expect(name).toHaveValue('Updated Admin');
});

test('availability closes and clears selection when editing becomes disabled', async ({page, openApp, backend}) => {
  backend.raw.months[0].current_publication_id = null;
  await openApp('a');
  await page.getByRole('tab', {name: 'Availability', exact: true}).click();
  const day = page.getByRole('button', {name: /^5 Nov.*Available/});
  await day.click();
  await page.getByLabel('Description (optional)').fill('Unsaved note');
  backend.raw.months[0].status = 'published';
  const loaded = page.waitForResponse('**/rest/v1/rpc/duty_load');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await loaded;
  await expect(day).toBeDisabled();
  await expect(day).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByLabel('Description (optional)')).toBeHidden();
  expect(backend.calls.filter(c => c.name === 'duty_set_constraints')).toHaveLength(0);
});

test('team drag binding retains pointer and touch reorder announcements', async ({page, openApp, backend}, info) => {
  await openApp();
  await page.getByRole('tab', {name: 'Team & fairness', exact: true}).click();
  const from = page.getByRole('button', {name: 'Drag to reorder Avery Admin'});
  const to = page.getByRole('button', {name: 'Drag to reorder Alex Atlas'});
  await from.scrollIntoViewIfNeeded();
  const a = (await from.boundingBox())!, b = (await to.boundingBox())!;
  const x = a.x + a.width / 2, y = a.y + a.height / 2;
  const tx = b.x + b.width / 2, ty = b.y + b.height / 2;
  if (info.project.name === 'mobile') {
    await touchEvent(page, 'touchstart', x, y);
    await page.waitForTimeout(400);
    await touchEvent(page, 'touchmove', tx, ty);
    await touchEvent(page, 'touchend', tx, ty);
  } else {
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(tx, ty, {steps: 8}); await page.mouse.up();
  }
  await expect(page.locator('[aria-live="polite"]').filter({hasText: 'Avery Admin · 2'})).toHaveCount(1);
  await expect.poll(() => backend.calls.filter(c => c.name === 'duty_save_schedule').length).toBe(1);
});
