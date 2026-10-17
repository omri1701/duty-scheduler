import {test, expect, ids} from './fixtures';
import {resolveEnvironment} from '../../lib/supabase/environment';

test('returning authenticated users enter the calendar without Google OAuth', async ({page, openApp, backend}) => {
  backend.googleEnabled = true;
  const settings: string[] = [];
  page.on('request', request => {if (new URL(request.url()).pathname === '/auth/v1/settings') settings.push(request.url());});
  await openApp('a');
  await expect(page.getByRole('tab', {name: 'Schedule', exact: true})).toBeVisible();
  await page.reload();
  await expect(page.getByRole('tab', {name: 'Schedule', exact: true})).toBeVisible();
  expect(backend.oauthRequests).toEqual([]);
  expect(settings).toEqual([]);
  expect(backend.calls.every(call => call.name === 'duty_load' && call.user === ids.a)).toBe(true);
});

for (const [identity, heading] of [
  ['b', null],
  ['pending', 'Waiting for approval'],
  ['rejected', 'Request declined'],
  ['inactive', 'Membership inactive'],
] as const) {
  test(`sign-out then Google login selects a separate ${identity} identity`, async ({page, openApp, backend, baseURL}) => {
    backend.googleEnabled = true;
    await openApp('admin');
    const storageKey = resolveEnvironment(backend.url, new URL(baseURL!).origin).storageKey;
    const logout = page.waitForRequest('**/auth/v1/logout*');
    await page.getByRole('button', {name: 'Sign out', exact: true}).click();
    expect((await logout).method()).toBe('POST');
    await expect(page.getByRole('button', {name: 'Continue with Google'})).toBeVisible();
    expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
    expect(backend.oauthRequests).toEqual([]);
    await expect(page.getByRole('button', {name: 'My profile'})).toHaveCount(0);
    await page.getByRole('button', {name: 'Continue with Google'}).click();
    await expect(page.getByRole('heading', {name: 'Synthetic OAuth handoff'})).toBeVisible();
    expect(backend.oauthRequests).toHaveLength(1);
    expect(backend.oauthRequests[0].searchParams.get('prompt')).toBe('select_account');
    expect(backend.oauthRequests[0].searchParams.get('code_challenge')).toBeTruthy();

    // Simulate Google's choice and the Supabase callback; no real provider/data.
    const before = backend.calls.length;
    const exchange = page.waitForRequest('**/auth/v1/token?grant_type=pkce');
    await openApp(identity, page, {oauthReturn: true});
    expect((await exchange).postDataJSON()).toMatchObject({auth_code: 'synthetic-oauth-code', code_verifier: 'synthetic-verifier'});
    const selectedId = identity === 'rejected' || identity === 'inactive' ? ids.a : ids[identity];
    expect(backend.calls.slice(before).every(call => call.user === selectedId)).toBe(true);
    expect(backend.calls.slice(before).map(call => call.name)).toEqual(['duty_load']);
    const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), storageKey);
    expect(stored.user.id).toBe(selectedId);
    expect(stored.user.id).not.toBe(ids.admin);
    expect(new URL(page.url()).searchParams.has('code')).toBe(false);
    if (heading) {
      await expect(page.getByRole('heading', {name: heading})).toBeVisible();
      await expect(page.getByRole('tab', {name: 'Schedule', exact: true})).toHaveCount(0);
    } else {
      await expect(page.getByRole('tab', {name: 'Schedule', exact: true})).toBeVisible();
      await page.getByRole('button', {name: 'My profile', exact: true}).click();
      await expect(page.getByRole('textbox', {name: 'Display name'})).toHaveValue('Blair Birch');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', {name: 'Publish', exact: true})).toHaveCount(0);
    }
    await expect(page.getByText('Synthetic vacation')).toHaveCount(0);
  });
}

test('Google callback for a new identity registers only a pending engineer', async ({page, openApp, backend}) => {
  backend.googleEnabled = true;
  backend.raw.members = backend.raw.members.filter(member => member.id !== ids.pending);
  await openApp('pending', page, {oauthReturn: true});
  await expect(page.getByRole('heading', {name: 'Waiting for approval'})).toBeVisible();
  await expect(page.getByRole('tab', {name: 'Schedule', exact: true})).toHaveCount(0);
  expect(backend.calls.map(call => [call.name, call.user])).toEqual([
    ['duty_load', ids.pending], ['duty_join', ids.pending], ['duty_load', ids.pending],
  ]);
  expect(backend.raw.members.find(member => member.id === ids.pending)).toMatchObject({role: 'engineer', status: 'pending', active: false});
});
