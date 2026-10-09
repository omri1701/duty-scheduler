// Scenarios promoted from the former optional tests/browser/swaps.mjs script.
import {test, expect, ids, duty, drag, keyboardRequest, confirmRequest, touchEvent} from './fixtures';

test('published drag and keyboard request cancellation do not edit duties', async ({page, openApp, backend}, info) => {
  await openApp('a');
  await expect(page.getByRole('region', {name: 'Swap Requests'})).toHaveCount(0);
  await duty(page, '2026-11-02').focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
  await expect(duty(page, '2026-11-02')).toHaveAttribute('aria-pressed', 'false');
  await keyboardRequest(page);
  await page.getByRole('button', {name: 'Cancel', exact: true}).click();
  expect(backend.calls.filter(c => c.name === 'duty_request_swap')).toHaveLength(0);
  await drag(page, info.project.name === 'mobile');
  await page.getByLabel('Explanation (optional)').fill('Synthetic swap reason');
  await confirmRequest(page);
  await expect(page.getByText('Awaiting Engineer', {exact: true})).toBeVisible();
  await expect(duty(page, '2026-11-02')).toHaveAccessibleName(/Alex Atlas/);
  await page.getByRole('button', {name: 'Cancel request'}).click();
  await expect(page.getByText('Cancelled', {exact: true})).toBeVisible();
  expect(backend.raw.assignments.find(d => d.day === '2026-11-02' && d.publication_id)!.primary_id).toBe(ids.a);
});

test('consent gates admin review; rejection, approval and invalidation update each identity', async ({page, browser, openApp, backend}) => {
  await openApp('a');
  // Separate contexts are essential: sign-in state must not leak between identities.
  const options = {viewport: page.viewportSize()!, timezoneId: 'Asia/Jerusalem', locale: 'en-GB', serviceWorkers: 'block' as const};
  const bc = await browser.newContext(options), ac = await browser.newContext(options);
  try {
    const b = await bc.newPage(), admin = await ac.newPage();
    await openApp('b', b); await openApp('admin', admin);
    await keyboardRequest(page); await confirmRequest(page);
    await admin.reload();
    await expect(admin.getByRole('region', {name: 'Swap Requests'})).toHaveCount(0);
    await b.reload(); await b.getByRole('button', {name: 'Decline', exact: true}).click();
    await page.reload(); await expect(page.getByText('Declined', {exact: true})).toBeVisible();
    await keyboardRequest(page); await confirmRequest(page);
    await b.reload(); await b.getByRole('button', {name: 'Accept', exact: true}).click();
    await admin.reload(); await admin.getByRole('button', {name: 'Reject', exact: true}).click();
    await page.reload(); await expect(page.getByText('Rejected', {exact: true})).toBeVisible();
    await keyboardRequest(page); await confirmRequest(page);
    await b.reload(); await b.getByRole('button', {name: 'Next month'}).click();
    await b.getByRole('button', {name: 'Accept', exact: true}).click();
    const draft = structuredClone(backend.raw.assignments.filter(d => d.publication_id === null));
    await admin.reload(); await admin.getByRole('button', {name: 'Approve', exact: true}).click();
    await admin.getByRole('checkbox', {name: 'Explicitly override availability conflicts'}).check();
    await expect(admin.getByRole('button', {name: 'Approve & publish swap'})).toBeDisabled();
    await admin.getByLabel('Required audit reason').fill('Synthetic manager audit reason');
    await admin.getByRole('button', {name: 'Approve & publish swap'}).click();
    await expect(admin.getByRole('dialog')).toBeHidden();
    await page.reload(); await expect(page.getByText('Approved', {exact: true})).toBeVisible();
    await expect(duty(page, '2026-11-02')).toHaveAccessibleName(/Blair Birch/);
    await expect(duty(page, '2026-11-03')).toHaveAccessibleName(/Alex Atlas/);
    await expect(duty(page, '2026-11-02')).toContainText('+ Casey');
    expect(backend.raw.assignments.filter(d => d.publication_id === null)).toEqual(draft);
    expect(backend.raw.publications.map(p => p.version)).toEqual([1, 2]);
    // A response signalling stale ownership must produce the existing UI error.
    await duty(page, '2026-11-03').click(); await duty(page, '2026-11-02').click(); await confirmRequest(page);
    backend.invalidated = true;
    await b.reload(); await b.getByRole('button', {name: 'Accept', exact: true}).click();
    await expect(b.getByText('This request was invalidated because its published duties are no longer eligible.', {exact: true})).toBeVisible();
    await page.reload(); await expect(page.getByText('Invalidated', {exact: true})).toBeVisible();
  } finally {await bc.close(); await ac.close();}
});

test('mobile scroll cancels hold; long press opens request', async ({page, openApp}, info) => {
  test.skip(info.project.name !== 'mobile', 'Native touch event simulation belongs to the mobile project.');
  await openApp('a');
  await duty(page, '2026-11-02').scrollIntoViewIfNeeded();
  const box = (await duty(page, '2026-11-02').boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await touchEvent(page, 'touchstart', x, y); await touchEvent(page, 'touchmove', x, y + 30);
  await page.waitForTimeout(400); await touchEvent(page, 'touchend', x, y + 30);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await drag(page, true); await expect(page.getByRole('dialog', {name: 'Confirm swap request'})).toBeVisible();
});

test('changed counterpart clears consent in all four client views', async ({page, browser, openApp, backend}) => {
  await openApp('a');
  const contexts = await Promise.all(['b', 'c', 'admin'].map(() => browser.newContext({viewport: page.viewportSize()!, timezoneId: 'Asia/Jerusalem', locale: 'en-GB', serviceWorkers: 'block'})));
  try {
    const [b, c, admin] = await Promise.all(contexts.map(context => context.newPage()));
    await openApp('b', b); await openApp('c', c); await openApp('admin', admin);
    await keyboardRequest(page); await confirmRequest(page);
    await b.reload(); await b.getByRole('button', {name: 'Accept', exact: true}).click();
    await admin.reload(); await expect(admin.getByRole('button', {name: 'Approve', exact: true})).toBeVisible();
    // Synthetic server response after another publication reassigns the target.
    const request = backend.raw.swapRequests![0];
    backend.raw.assignments.find(d => d.day === request.to_day && d.publication_id === request.source_publication_id)!.primary_id = ids.c;
    Object.assign(request, {other_id: ids.c, status: 'awaiting_engineer', accepted_by: null, accepted_at: null});
    backend.raw.revision!++;
    await Promise.all([page.reload(), b.reload(), c.reload(), admin.reload()]);
    await expect(b.getByRole('region', {name: 'Swap Requests'})).toHaveCount(0);
    await expect(admin.getByRole('region', {name: 'Swap Requests'})).toHaveCount(0);
    await expect(page.getByText('Awaiting Engineer', {exact: true})).toBeVisible();
    await expect(c.getByRole('button', {name: 'Accept', exact: true})).toBeVisible();
  } finally {await Promise.all(contexts.map(context => context.close()));}
});
