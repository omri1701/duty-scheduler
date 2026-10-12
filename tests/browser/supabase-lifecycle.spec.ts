import {test, expect, ids} from './fixtures';

function gate() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => {release = resolve;});
  return {wait, release};
}

test('late private workspace refresh cannot restore data after sign-out', async ({page, openApp, backend}) => {
  await openApp();
  const held = gate(), started = gate();
  const privateSnapshot = backend.snapshot(ids.admin);
  await page.route('**/rest/v1/rpc/duty_load', async route => {
    started.release(); await held.wait; await route.fulfill({json: privateSnapshot});
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await started.wait;
  await page.getByRole('button', {name: 'Sign out', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Continue with Google'})).toBeVisible();
  const late = page.waitForResponse('**/rest/v1/rpc/duty_load');
  held.release(); await (await late).finished();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.getByRole('button', {name: 'Continue with Google'})).toBeVisible();
  await expect(page.getByRole('button', {name: 'My profile'})).toHaveCount(0);
  await expect(page.getByText('Synthetic vacation')).toHaveCount(0);
});

test('save reload wins over a delayed older refresh and supplies the next revision', async ({page, openApp, backend}) => {
  await openApp();
  const held = gate(), started = gate(), oldSnapshot = backend.snapshot(ids.admin);
  let first = true;
  await page.route('**/rest/v1/rpc/duty_load', async route => {
    if (!first) return route.fallback();
    first = false; started.release(); await held.wait; await route.fulfill({json: oldSnapshot});
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await started.wait;
  await page.getByRole('button', {name: 'My profile', exact: true}).click();
  await page.getByRole('textbox', {name: 'Display name'}).fill('Updated Admin');
  await page.getByRole('button', {name: 'Save name', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('.admin-avatar')).toHaveText('UA');
  const late = page.waitForResponse('**/rest/v1/rpc/duty_load');
  held.release(); await (await late).finished();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.locator('.admin-avatar')).toHaveText('UA');
  await page.getByRole('button', {name: 'My profile', exact: true}).click();
  await expect(page.getByRole('textbox', {name: 'Display name'})).toHaveValue('Updated Admin');
  await page.getByRole('textbox', {name: 'Display name'}).fill('Latest Admin');
  await page.getByRole('button', {name: 'Save name', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(backend.calls.filter(c => c.name === 'duty_rename_self').map(c => c.params.p_revision)).toEqual([1, 2]);
});
