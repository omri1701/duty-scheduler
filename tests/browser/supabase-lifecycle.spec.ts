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

test('restored private data waits for verified auth and skips registration', async ({page,openApp,backend}) => {
  const held=gate(),started=gate();let verifications=0;
  backend.authGate=held.wait;
  page.on('request',request=>{if(new URL(request.url()).pathname==='/auth/v1/user'){verifications++;started.release();}});
  const loaded=page.waitForResponse('**/rest/v1/rpc/duty_load');
  const opening=openApp();
  try {
    await started.wait;
    await loaded;
    await expect(page.locator('.calendar-grid')).toHaveCount(0);
    await expect(page.getByRole('button',{name:'My profile'})).toHaveCount(0);
    expect(backend.calls.filter(c=>c.name==='duty_join')).toHaveLength(0);
  } finally {held.release();}
  await opening;await expect(page.locator('.calendar-grid')).toBeVisible();
  expect(verifications).toBe(1);expect(backend.calls.filter(c=>c.name==='duty_load')).toHaveLength(1);
});

test('focus and visibility share auth revalidation and one workspace load', async ({page,openApp,backend}) => {
  await openApp();const before=backend.calls.filter(c=>c.name==='duty_load').length;
  const held=gate(),started=gate();let verifications=0;
  await page.route('**/auth/v1/user',async route=>{verifications++;started.release();await held.wait;await route.fallback();});
  await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('visibilitychange'));});
  await started.wait;
  await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('visibilitychange'));});
  const loaded=page.waitForResponse('**/rest/v1/rpc/duty_load');held.release();await loaded;
  await expect.poll(()=>backend.calls.filter(c=>c.name==='duty_load').length).toBe(before+1);
  expect(verifications).toBe(1);
});

for(const identity of ['pending','inactive'] as const) {
  test(`${identity} restored members do not register again`,async({page,openApp,backend})=>{
    await openApp(identity);expect(backend.calls.map(c=>c.name)).toEqual(['duty_load']);
    await expect(page.locator('.calendar-grid')).toHaveCount(0);
  });
}

test('a missing profile registers once and remains pending without private workspace data',async({page,openApp,backend})=>{
  backend.raw.members=backend.raw.members.filter(member=>member.id!==ids.pending);
  await openApp('pending');
  await expect(page.getByRole('heading',{name:'Waiting for approval'})).toBeVisible();
  await expect(page.locator('.calendar-grid')).toHaveCount(0);
  expect(backend.calls.map(c=>c.name)).toEqual(['duty_load','duty_join','duty_load']);
  expect(backend.raw.members.find(member=>member.id===ids.pending)).toMatchObject({status:'pending',active:false,role:'engineer'});
});
